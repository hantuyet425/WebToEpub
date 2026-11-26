"use strict";

class Download {
    constructor() {
    }

    static init() {
        Download.saveOn = util.isFirefox() ? Download.saveOnFirefox : Download.saveOnChrome;
        if (util.isFirefox()) {
            Download.saveOn = Download.saveOnFirefox;
            browser.downloads.onChanged.addListener(Download.onChanged);
        } else {
            Download.saveOn = Download.saveOnChrome;
            chrome.downloads.onChanged.addListener(Download.onChanged);
        }
    }

    static isFileNameIllegalOnWindows(fileName) {
        for (let c of Download.illegalWindowsFileNameChars) {
            if (fileName.includes(c)) {
                return true;
            }
        }
        if (fileName.trim() == "") {
            return true;
        }
        return false;
    }

    static CustomFilename(extension = ".epub") {
        let CustomFilename = document.getElementById("CustomFilenameInput").value;
        let ToReplace = {
            "%URL_hostname%": (new URL(document.getElementById("startingUrlInput").value))?.hostname,
            "%Title%": document.getElementById("titleInput").value,
            "%Author%": document.getElementById("authorInput").value,
            "%Language%": document.getElementById("languageInput").value,
            "%Chapters_Count%":  document.getElementById("spanChapterCount").innerHTML,
            "%Chapters_Downloaded%":  document.getElementById("fetchProgress").value-1,
            "%Filename%": document.getElementById("fileNameInput").value,
        };
        for (const [key, value] of Object.entries(ToReplace)) {
            CustomFilename = CustomFilename.replaceAll(key, value);
        }
        CustomFilename = CustomFilename.trim().replace(/\.(epub|txt)$/i, "").trim();
        if (Download.isFileNameIllegalOnWindows(CustomFilename)) {
            ErrorLog.showErrorMessage(UIText.Error.errorIllegalFileName(CustomFilename, Download.illegalWindowsFileNameChars));

            let userPreferences = main.getUserPreferences();
            if (userPreferences.removeIllegalCharacterFromFilenameOnDownload.value) {
                let newCustomFilename = CustomFilename;
                for (let c of Download.illegalWindowsFileNameChars) {
                    newCustomFilename = newCustomFilename.replaceAll(c, "");
                }
                newCustomFilename = newCustomFilename.trim();
                if (newCustomFilename == "") {
                    return EpubPacker.addExtensionIfMissing("IllegalFileName", extension);
                }
                return EpubPacker.addExtensionIfMissing(newCustomFilename, extension);
            }

            return EpubPacker.addExtensionIfMissing("IllegalFileName", extension);
        }
        return EpubPacker.addExtensionIfMissing(CustomFilename, extension);
    }

    /** write blob to "Downloads" directory */
    static save(blob, fileName, overwriteExisting, backgroundDownload) {
        let extension = fileName.toLowerCase().endsWith(".txt") ? ".txt" : ".epub";
        if (Download.isFileNameIllegalOnWindows(fileName.replace(/\.(epub|txt)$/i, ""))) {
            ErrorLog.showErrorMessage(UIText.Error.errorIllegalFileName(fileName, Download.illegalWindowsFileNameChars));

            let userPreferences = main.getUserPreferences();
            if (userPreferences.removeIllegalCharacterFromFilenameOnDownload.value) {
                let newFileName = fileName;
                for (let c of Download.illegalWindowsFileNameChars) {
                    newFileName = newFileName.replaceAll(c, "");
                }
                let name = newFileName.replace(/\.(epub|txt)$/i, "").trim() || "IllegalFileName";
                fileName = EpubPacker.addExtensionIfMissing(name, extension);
            }
            else {
                fileName = EpubPacker.addExtensionIfMissing("IllegalFileName", extension);
            }            
        }
        let options = {
            url: URL.createObjectURL(blob),
            filename: fileName,
            saveAs: !backgroundDownload
        };
        if (overwriteExisting) {
            options.conflictAction = "overwrite";
        }
        let cleanup = () => { URL.revokeObjectURL(options.url); };
        return Download.saveOn(options, cleanup);
    }

    static saveOnChrome(options, cleanup) {
        // on Chrome call to download() will resolve when "Save As" dialog OPENS
        // so need to delay return until after file is actually saved
        // Otherwise, we get multiple Save As Dialogs open.
        return new Promise((resolve,reject) => {
            chrome.downloads.download(options, 
                downloadId => Download.downloadCallback(downloadId, cleanup, resolve, reject)
            );
        });
    }

    static downloadCallback(downloadId, cleanup, resolve, reject) {
        if (downloadId === undefined) {
            reject(new Error(chrome.runtime.lastError.message));
        } else {
            Download.onDownloadStarted(downloadId, 
                () => { 
                    const tenSeconds = 10 * 1000;
                    setTimeout(cleanup, tenSeconds);
                    resolve();
                }
            );
        }
    }

    static saveOnFirefox(options, cleanup) {
        return browser.runtime.getPlatformInfo().then(platformInfo => {
            if (Download.isAndroid(platformInfo)) {
                Download.saveOnFirefoxForAndroid(options, cleanup);
            } else {
                return browser.downloads.download(options).then(
                    // on Firefox, resolves when "Save As" dialog CLOSES, so no
                    // need to delay past this point.
                    downloadId => Download.onDownloadStarted(downloadId, cleanup)
                );
            }
        }).catch(cleanup);
    }

    static saveOnFirefoxForAndroid(options, cleanup) {
        options.saveAs = false;

        // `browser.downloads.download` isn't implemented in
        // "Firefox for Android" yet, so we starts downloads
        // the same way any normal web page would do it:
        const link = document.createElement("a");
        link.style.display = "hidden";

        link.href = options.url;
        link.download = options.filename;

        document.body.appendChild(link);
        try {
            link.click();
        } finally {
            document.body.removeChild(link);
        }
        cleanup();
    }

    static isAndroid(platformInfo) {
        return platformInfo.os.toLowerCase().includes("android");
    }

    static onChanged(delta) {
        if ((delta.state != null) && (delta.state.current === "complete")) {
            let action = Download.toCleanup.get(delta.id);
            if (action != null) {
                Download.toCleanup.delete(delta.id);
                action();
            }
        }
    }

    static onDownloadStarted(downloadId, action) {
        if (downloadId === undefined) {
            action();
        } else {
            Download.toCleanup.set(downloadId, action);
        }
    }
}

Download.toCleanup = new Map();
Download.illegalWindowsFileNameChars = "~/?<>\\:*|\"";
Download.init();
