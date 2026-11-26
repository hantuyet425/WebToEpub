"use strict";

class TextPacker {
    static assemble(epubItemSupplier) {
        let chapters = epubItemSupplier.spineItems()
            .filter(item => item.nodes != null)
            .map(item => {
                let content = item.nodes.map(node => TextPacker.nodeText(node)).join("")
                    .replace(/[ \t]+\n/g, "\n")
                    .replace(/\n{3,}/g, "\n\n")
                    .trim();
                let title = (item.chapterTitle || "").trim();
                let firstLine = content.split("\n", 1)[0].trim();
                if (title && firstLine !== title) {
                    content = title + "\n\n" + content;
                }
                if (item.newArc) {
                    content = item.newArc + "\n\n" + content;
                }
                return content;
            }).filter(content => content.length > 0);
        let text = chapters.join("\n\n\n").replace(/\n/g, "\r\n");
        // A BOM lets Windows text editors detect UTF-8 reliably.
        return new Blob(["\uFEFF", text, "\r\n"], {type: "text/plain;charset=utf-8"});
    }

    static nodeText(node, preserveWhitespace = false) {
        if (node.nodeType === Node.TEXT_NODE) {
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
