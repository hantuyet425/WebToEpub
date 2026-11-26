"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {DOMParser} = require("@xmldom/xmldom");
const root = path.join(__dirname, "..");

function load(file, context) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
}

function textPacker() {
    const context = vm.createContext({Blob, Node: {TEXT_NODE: 3, ELEMENT_NODE: 1}});
    load("plugin/js/TextPacker.js", context);
    return vm.runInContext("TextPacker", context);
}

function item(html, title = "") {
    const doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/xml");
    return {nodes: Array.from(doc.documentElement.childNodes), chapterTitle: title};
}

test("TXT keeps Unicode, chapter order, paragraphs, line breaks and inline words", async () => {
    const packer = textPacker();
    const items = [
        item("<h1>Chương 2: Gặp gỡ</h1><p>Hàn <b>Hoang</b> &amp; phụ thân.</p><p>你好<br/>Dòng hai.</p>", "Chương 2: Gặp gỡ"),
        item("<div>Một đoạn.</div><div>Đoạn tiếp.</div>", "Chương 1")
    ];
    const blob = packer.assemble({spineItems: () => items});
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual(Array.from(bytes.slice(0, 3)), [239, 187, 191]);
    assert.equal(blob.type, "text/plain;charset=utf-8");
    assert.equal(await blob.text(), "Chương 2: Gặp gỡ\r\n\r\nHàn Hoang & phụ thân.\r\n\r\n你好\r\nDòng hai.\r\n\r\n\r\nChương 1\r\n\r\nMột đoạn.\r\n\r\nĐoạn tiếp.\r\n");
    assert.equal(items[0].nodes.length, 3);
});

test("TXT omits images and script/style content, retains preformatted lines and table cells", async () => {
    const packer = textPacker();
    const content = item("<script>bad()</script><style>bad{}</style><img src='cover.jpg'/><pre>line 1\n  line 2</pre><table><tr><td>A</td><td>B</td></tr></table>");
    const text = await packer.assemble({spineItems: () => [{isImage: true}, content]}).text();
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
        Blob, Node: {TEXT_NODE: 3, ELEMENT_NODE: 1}, window: {}, initialMetaInfo: null, userPreferences: prefs,
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
            epubItemSupplier: () => ({spineItems: () => [item("<p>Nội dung.</p>", "Chương 1")]}),
            updateReadingList() {}
        },
        Download: {CustomFilename: ext => "Truyện" + ext, save: (blob, name) => saved.push({blob, name})},
        library: {LibAddToLibrary: (blob, name) => library.push({blob, name})},
        packEpub: () => new Blob(["epub"], {type: "application/epub+zip"}),
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
    context.Download.save = () => new Promise(resolve => {finishSave = resolve;});
    const exporting = context.exportStory.call({dataset: {}});
    await new Promise(resolve => setImmediate(resolve));
    fields.packEpubButton.disabled = true;
    context.window.workInProgress = true;
    finishSave();
    await exporting;
    assert.equal(fields.packEpubButton.disabled, true);
    assert.equal(context.window.workInProgress, true);
});
