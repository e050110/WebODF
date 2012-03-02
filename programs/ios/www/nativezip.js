/*global PhoneGap, core*/
var ZipPlugin = {
    loadAsString: function (zippath, entrypath, success, fail) {
        "use strict";
        return PhoneGap.exec(success, fail, "ZipClass", "loadAsString", [zippath, entrypath]);
    },
    loadAsDataURL: function (zippath, entrypath, success, fail) {
        "use strict";
        return PhoneGap.exec(success, fail, "ZipClass", "loadAsDataURL", [zippath, entrypath]);
    }
};
core.Zip = function (url, entriesReadCallback) {
    "use strict";
    // remove 'odf:' prefix
    url = url.substr(4);
    var zip = this;
    this.load = function (filename, callback) {
        //alert(filename);
        callback(null, "");
    };
    /**
     * @param {!string} filename
     * @param {!function(?string, ?string)} callback receiving err and data
     * @return {undefined}
     */
    this.loadAsString = function (filename, callback) {
        ZipPlugin.loadAsString(url, filename,
            function (content) {
                callback(null, content);
            },
            function (err) { callback(err, null); }
            );
    };
    this.loadAsDataURL = function (filename, callback) {
        ZipPlugin.loadAsDataURL(url, filename,
            function (content) {
                callback(null, content);
            },
            function (err) { callback(err, null); }
            );
    };
    this.getEntries = function () {
        alert("getEntries");
    };
    this.loadContentXmlAsFragments = function (filename, handler) {
        // the javascript implementation simply reads the file
        zip.loadAsString(filename, function (err, data) {
            if (err) {
                return handler.rootElementReady(err);
            }
            handler.rootElementReady(null, data, true);
        });
    };
    this.save = function () {
        alert("save");
    };
    this.write = function () {
        alert("write");
    };
    entriesReadCallback(null, this);
};
