"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {DOMParser} = require("@xmldom/xmldom");
const zip = require("@zip.js/zip.js");
const root = path.join(__dirname, "..");

function load(file, context) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
}

function textPacker() {
    const context = vm.createContext({Blob, DOMParser, URL, zip, Node: {TEXT_NODE: 3, ELEMENT_NODE: 1}});
    load("plugin/js/TextPacker.js", context);
    return vm.runInContext("TextPacker", context);
}

async function epub(items) {
    const writer = new zip.ZipWriter(new zip.BlobWriter("application/epub+zip"), {useWebWorkers: false, level: 0});
    const add = (name, text) => writer.add(name, new zip.TextReader(text));
    await add("META-INF/container.xml", '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
    const manifest = items.map((item, i) => '<item id="c' + i + '" href="Text/' + i + '.xhtml" media-type="application/xhtml+xml"/>').join("");
    const spine = items.map((item, i) => '<itemref idref="c' + i + '"/>').join("");
    await add("OEBPS/content.opf", '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>' + manifest + '</manifest><spine><itemref idref="cover"/>' + spine + '</spine></package>');
    await add("OEBPS/Text/cover.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="cover.jpg"/></body></html>');
    // Deliberately insert physical files in reverse order.
    for (let i = items.length - 1; i >= 0; --i) {
        await add("OEBPS/Text/" + i + ".xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>TOC title</title></head><body>' + items[i] + '</body></html>');
    }
    return writer.close();
}

test("TXT keeps Unicode, chapter order, paragraphs, line breaks and inline words", async () => {
    const packer = textPacker();
    const items = [
        "<h1>Chương 2: Gặp gỡ</h1><p>Hàn <b>Hoang</b> &amp; phụ thân.</p><p>你好<br/>Dòng hai.</p>",
        "<h1>Chương 1</h1><div>Một đoạn.</div><div>Đoạn tiếp.</div>"
    ];
    const blob = await packer.assemble(await epub(items));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual(Array.from(bytes.slice(0, 3)), [239, 187, 191]);
    assert.equal(blob.type, "text/plain;charset=utf-8");
    assert.equal(await blob.text(), "Chương 2: Gặp gỡ\r\n\r\nHàn Hoang & phụ thân.\r\n\r\n你好\r\nDòng hai.\r\n\r\n\r\nChương 1\r\n\r\nMột đoạn.\r\n\r\nĐoạn tiếp.\r\n");
});

test("TXT omits images and script/style content, retains preformatted lines and table cells", async () => {
    const packer = textPacker();
    const content = "<script>bad()</script><style>bad{}</style><img src='cover.jpg'/><pre>line 1\n  line 2</pre><table><tr><td>A</td><td>B</td></tr></table>";
    const text = await (await packer.assemble(await epub([content]))).text();
    assert.equal(text, "line 1\r\n  line 2\r\n\r\nA\tB\r\n");
});

function downloadContext() {
    const errors = [];
    const fields = {
        CustomFilenameInput: {value: "%Title%"}, startingUrlInput: {value: "https://example.com/story"},
        titleInput: {value: "Truyện"}, authorInput: {value: "Tác giả"}, languageInput: {value: "vi"},
        spanChapterCount: {innerHTML: "2"}, fetchProgress: {value: 3}, fileNameInput: {value: "Truyện"}
    };
    const context = vm.createContext({
        Blob, URL, document: {getElementById: id => fields[id]}, util: {isFirefox: () => false},
        chrome: {downloads: {onChanged: {addListener() {}}}},
        ErrorLog: {showErrorMessage: e => errors.push(e)},
        UIText: {Error: {errorIllegalFileName: name => name}},
        main: {getUserPreferences: () => ({removeIllegalCharacterFromFilenameOnDownload: {value: true}})}
    });
    load("plugin/js/EpubPacker.js", context);
    load("plugin/js/Download.js", context);
    return {Download: vm.runInContext("Download", context), fields, errors};
}

test("custom filenames and invalid-name fallbacks keep the chosen extension", () => {
    const {Download, fields} = downloadContext();
    for (const name of ["%Title%", "Truyện.epub", "Truyện.TXT"]) {
        fields.CustomFilenameInput.value = name;
        assert.equal(Download.CustomFilename(".txt"), "Truyện.txt");
    }
    assert.equal(Download.CustomFilename(), "Truyện.epub");
    fields.CustomFilenameInput.value = "<>.epub";
    assert.equal(Download.CustomFilename(".txt"), "IllegalFileName.txt");
    Download.saveOn = (options, cleanup) => {
        assert.equal(options.filename, "IllegalFileName.txt");
        cleanup();
    };
    Download.save(new Blob(["text"]), "<>.txt");
});

function exportContext(failFetch = false, pause = false) {
    const fields = {
        packEpubButton: {disabled: false}, LibAddToLibrary: {hidden: false}, LibPauseToLibrary: {hidden: true},
        noAdditionalMetadataCheckbox: {checked: false}, chaptersPageInChapterListCheckbox: {checked: false},
        startingUrlInput: {value: "https://example.com/story"}
    };
    const saved = [], library = [], errors = [];
    const prefs = {};
    for (const name of ["maxChaptersPerEpub", "overwriteExistingEpub", "noDownloadPopup"]) prefs[name] = {value: false};
    let signal = {aborted: false};
    const context = vm.createContext({
        Blob, DOMParser, URL, zip, Node: {TEXT_NODE: 3, ELEMENT_NODE: 1}, window: {}, initialMetaInfo: null, userPreferences: prefs,
        document: {getElementById: id => fields[id]}, metaInfoFromControls: () => ({}),
        main: {getPackEpubButton: () => fields.packEpubButton},
        util: {getSleepController: () => ({signal}), resetSleepController: () => {signal = {aborted: false};}},
        ChapterUrlsUI: {limitNumOfChapterS() {}, resetDownloadStateImages() {}},
        ErrorLog: {clearHistory() {}, showErrorMessage: err => errors.push(err.message), showLogToUser() {}},
        parser: {
            onStartCollecting() {},
            async fetchContent() {
                if (failFetch) throw new Error("No chapters found.");
                signal.aborted = pause;
            },
            state: {webPages: new Map()},
            updateReadingList() {}
        },
        Download: {CustomFilename: ext => "Truyện" + ext, save: (blob, name) => saved.push({blob, name})},
        library: {LibAddToLibrary: (blob, name) => library.push({blob, name})},
        packEpub: () => epub(["<h1>Chương 1</h1><p>Nội dung.</p>"]),
        resetUI() {}, dumpErrorLogToFile() {}
    });
    load("plugin/js/TextPacker.js", context);
    const source = fs.readFileSync(path.join(root, "plugin/js/main.js"), "utf8");
    const start = source.indexOf("    async function fetchContentAndPackEpub()");
    const end = source.indexOf("    function pauseToLibrary()", start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start, end) + ";globalThis.exportStory = fetchContentAndPackEpub;", context);
    return {context, fields, saved, library, errors};
}

test("main download saves TXT with the text exporter", async () => {
    const {context, saved, library, fields, errors} = exportContext();
    await context.exportStory.call({dataset: {}});
    assert.deepEqual(errors, []);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, "Truyện.txt");
    assert.equal(await saved[0].blob.text(), "Chương 1\r\n\r\nNội dung.\r\n");
    assert.equal(library.length, 0);
    assert.equal(fields.packEpubButton.disabled, false);
});

test("library and pause continue to receive EPUB blobs and filenames", async () => {
    for (const pause of [false, true]) {
        const {context, saved, library} = exportContext(false, pause);
        await context.exportStory.call({dataset: pause ? {} : {libclick: "yes"}});
        assert.equal(saved.length, 0);
        assert.equal(library.length, 1);
        assert.equal(library[0].name, "Truyện.epub");
        assert.equal(library[0].blob.type, "application/epub+zip");
    }
});

test("fetch errors stop saving and restore controls", async () => {
    const {context, fields, saved, library, errors} = exportContext(true);
    await context.exportStory.call({dataset: {}});
    assert.equal(saved.length + library.length, 0);
    assert.deepEqual(errors, ["No chapters found."]);
    assert.equal(context.window.workInProgress, false);
    assert.equal(fields.packEpubButton.disabled, false);
    assert.equal(fields.LibAddToLibrary.hidden, false);
    assert.equal(fields.LibPauseToLibrary.hidden, true);
});

test("save failures are reported without updating the reading list", async () => {
    const {context, errors, fields} = exportContext();
    let readingListUpdated = false;
    context.Download.save = async () => {throw new Error("Save cancelled");};
    context.parser.updateReadingList = () => {readingListUpdated = true;};
    await context.exportStory.call({dataset: {}});
    assert.deepEqual(errors, ["Save cancelled"]);
    assert.equal(readingListUpdated, false);
    assert.equal(fields.packEpubButton.disabled, false);
});

test("finishing an earlier save does not unlock a later download", async () => {
    const {context, fields} = exportContext();
    let finishSave;
    let started;
    const saving = new Promise(resolve => {started = resolve;});
    context.Download.save = () => new Promise(resolve => {finishSave = resolve; started();});
    const exporting = context.exportStory.call({dataset: {}});
    await Promise.race([saving, exporting]);
    assert.equal(typeof finishSave, "function");
    fields.packEpubButton.disabled = true;
    context.window.workInProgress = true;
    finishSave();
    await exporting;
    assert.equal(fields.packEpubButton.disabled, true);
    assert.equal(context.window.workInProgress, true);
});


test("only duplicate leading headings inside a single EPUB chapter are collapsed", async () => {
    const packer = textPacker();
    const book = await epub([
        "<h1>第1章 同名</h1><p>第1章 同名</p><p>甲</p>",
        "<h1>第2章 同名</h1><p>乙</p>",
        "<h1>第3章 故事（上）</h1><p>丙</p>",
        "<h1>第4章 故事（下）</h1><p>丁</p>",
        "<h1>第1章 同名</h1><p>戊</p>"
    ]);
    const text = await (await packer.assemble(book)).text();
    assert.equal(text, "第1章 同名\r\n\r\n甲\r\n\r\n\r\n第2章 同名\r\n\r\n乙\r\n\r\n\r\n第3章 故事（上）\r\n\r\n丙\r\n\r\n\r\n第4章 故事（下）\r\n\r\n丁\r\n\r\n\r\n第1章 同名\r\n\r\n戊\r\n");
});

test("empty and title-only spine items stop export", async () => {
    const packer = textPacker();
    for (const chapter of ["<p> </p>", "<h1>第1章 空</h1>", "<h1>第1章 空</h1><p>第1章 空</p>"]) {
        await assert.rejects(packer.assemble(await epub([chapter])), /no text/);
    }
});

test("failed selected chapters stop TXT even when parser supplies an EPUB placeholder", async () => {
    const {context, errors, saved} = exportContext();
    context.parser.state.webPages.set("bad", {isIncludeable: true, error: new Error("failed"), sourceUrl: "https://example.com/bad"});
    await context.exportStory.call({dataset: {}});
    assert.equal(saved.length, 0);
    assert.match(errors[0], /chapter\(s\) failed/);
});
