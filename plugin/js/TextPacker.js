"use strict";

class TextPacker {
    // Convert the finished EPUB, not the parser's intermediate DOM or TOC titles.
    static async assemble(epubBlob) {
        let reader = new zip.ZipReader(new zip.BlobReader(epubBlob), {useWebWorkers: false});
        try {
            let entries = new Map((await reader.getEntries()).filter(entry => !entry.directory)
                .map(entry => [entry.filename, entry]));
            let read = async path => {
                let entry = entries.get(path);
                if (!entry) {
                    throw new Error("Missing EPUB file: " + path);
                }
                return entry.getData(new zip.TextWriter());
            };
            let container = TextPacker.parseXml(await read("META-INF/container.xml"), "container.xml");
            let root = container.getElementsByTagNameNS("*", "rootfile")[0];
            let opfPath = root && root.getAttribute("full-path");
            if (!opfPath) {
                throw new Error("EPUB package path is missing.");
            }
            let opf = TextPacker.parseXml(await read(opfPath), opfPath);
            let manifest = opf.getElementsByTagNameNS("*", "manifest")[0];
            let spine = opf.getElementsByTagNameNS("*", "spine")[0];
            if (!manifest || !spine) {
                throw new Error("EPUB manifest or spine is missing.");
            }
            let items = new Map(Array.from(manifest.getElementsByTagNameNS("*", "item"))
                .map(item => [item.getAttribute("id"), item]));
            let chapters = [];
            for (let ref of Array.from(spine.getElementsByTagNameNS("*", "itemref"))) {
                let id = ref.getAttribute("idref");
                let item = items.get(id);
                if (!item) {
                    throw new Error("Unknown EPUB spine item: " + id);
                }
                if (id === "cover" || (item.getAttribute("properties") || "").split(/\s+/).includes("nav")) {
                    continue;
                }
                let href = item.getAttribute("href");
                let mediaType = item.getAttribute("media-type");
                if (!href || !["application/xhtml+xml", "text/html"].includes(mediaType)) {
                    throw new Error("Unsupported EPUB reading item: " + id);
                }
                let url = new URL(href, new URL(opfPath, "https://epub.invalid/"));
                if (url.origin !== "https://epub.invalid") {
                    throw new Error("External EPUB reading item: " + href);
                }
                let path = decodeURIComponent(url.pathname.slice(1));
                let doc = TextPacker.parseXml(await read(path), path);
                let body = doc.getElementsByTagNameNS("*", "body")[0];
                if (!body) {
                    throw new Error("Missing chapter body: " + path);
                }
                chapters.push(TextPacker.chapterText(body, path));
            }
            if (chapters.length === 0) {
                throw new Error("EPUB contains no readable chapters.");
            }
            let text = chapters.join("\n\n\n");
            return new Blob([text, "\n"], {type: "text/plain;charset=utf-8"});
        } finally {
            await reader.close();
        }
    }

    static parseXml(source, path) {
        let doc = new DOMParser().parseFromString(source, "application/xml");
        if (!doc.documentElement || doc.getElementsByTagNameNS("*", "parsererror").length) {
            throw new Error("Invalid EPUB XML: " + path);
        }
        return doc;
    }

    static chapterText(body, path) {
        let content = Array.from(body.childNodes).map(node => TextPacker.nodeText(node)).join("")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        let lines = content.split("\n");
        let comparable = value => value.normalize("NFKC").replace(/\s+/g, " ").trim();
        let chapterNumber = value => comparable(value).match(/^(?:第\s*([0-9零〇一二三四五六七八九十百千万两兩廿卅]+)\s*(?:章|回|节|節|卷|集|部|篇)|(?:chapter|chương)\s+([0-9]+))/iu);
        let first = comparable(lines[0]);
        let firstElement = Array.from(body.childNodes).find(node => node.nodeType === Node.ELEMENT_NODE
            && TextPacker.nodeText(node).trim());
        let leadingHeading = Boolean(chapterNumber(first) || (firstElement && /^h[1-6]$/i.test(firstElement.localName)
            && comparable(firstElement.textContent) === first));
        let number = chapterNumber(first);
        let headingKey = value => comparable(value).replace(/[\p{P}\s]+/gu, "");
        if (leadingHeading) {
            // Compare only consecutive leading titles within one XHTML item.
            let next = 1;
            while (next < lines.length) {
                if (!lines[next].trim()) {
                    next++;
                    continue;
                }
                let candidate = comparable(lines[next]);
                let candidateNumber = chapterNumber(candidate);
                let equivalent = candidate === first || (number && candidateNumber
                    && (number[1] || number[2]) === (candidateNumber[1] || candidateNumber[2])
                    && headingKey(first) === headingKey(candidate));
                if (!equivalent) {
                    break;
                }
                if (candidate.length > first.length) {
                    lines[0] = lines[next];
                    first = candidate;
                }
                lines.splice(next, 1);
            }
            if (!lines.slice(1).some(line => line.trim())) {
                throw new Error("Chapter has a heading but no text: " + path + " (" + first + ")");
            }
        }
        if (!content) {
            throw new Error("Chapter has no text: " + path);
        }
        return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().split("\n")
            .map((line, index) => !line.trim() || (index === 0 && leadingHeading) ? line : "  " + line)
            .join("\n");
    }

    static nodeText(node, preserveWhitespace = false) {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === 4) {
            let text = node.textContent.replace(/\r\n?/g, "\n");
            return preserveWhitespace ? text : text.replace(/[ \t\n\f]+/g, " ");
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return "";
        }
        let tag = node.localName.toLowerCase();
        if (["script", "style", "noscript", "template", "img", "svg"].includes(tag)) {
            return "";
        }
        if (tag === "br") {
            return "\n";
        }
        if (tag === "hr") {
            return "\n\n";
        }
        let text = Array.from(node.childNodes)
            .map(child => TextPacker.nodeText(child, preserveWhitespace || tag === "pre"))
            .join("");
        if (tag === "td" || tag === "th") {
            return text.trim() + "\t";
        }
        if (/^(p|div|h[1-6]|section|article|header|footer|blockquote|pre|ul|ol|li|dl|dt|dd|table|tr)$/.test(tag)) {
            return "\n\n" + text.trim() + "\n\n";
        }
        return text;
    }
}
