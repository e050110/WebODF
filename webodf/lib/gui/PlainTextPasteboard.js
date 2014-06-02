/**
 * Copyright (C) 2013 KO GmbH <copyright@kogmbh.com>
 *
 * @licstart
 * This file is part of WebODF.
 *
 * WebODF is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License (GNU AGPL)
 * as published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version.
 *
 * WebODF is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with WebODF.  If not, see <http://www.gnu.org/licenses/>.
 * @licend
 *
 * @source: http://www.webodf.org/
 * @source: https://github.com/kogmbh/WebODF/
 */

/*global runtime, gui, ops*/

/**
 *
 * @param {!ops.OdtDocument} odtDocument
 * @param {!string} inputMemberId
 * @constructor
 */
gui.PlainTextPasteboard = function PlainTextPasteboard(odtDocument, inputMemberId) {
    "use strict";

    /**
     * @param {!ops.Operation} op
     * @param {!Object} data
     * @return {!ops.Operation}
     */
    function createOp(op, data) {
        op.init(data);
        return op;
    }

    /**
     * @param {!string} data
     * @return {!Array.<!ops.Operation>}
     */
    this.createPasteOps = function (data) {
        var originalCursorPosition = odtDocument.getCursorPosition(inputMemberId),
            /**@type{number}*/
            cursorPosition = originalCursorPosition,
            operations = [],
            paragraphs;

        paragraphs = data.replace(/\r/g, "").split("\n");
        paragraphs.forEach(function (text) {
            operations.push(createOp(new ops.OpInsertText(), {
                memberid: inputMemberId,
                position: cursorPosition,
                text: text,
                moveCursor: true
            }));
            cursorPosition += text.length;

            operations.push(createOp(new ops.OpSplitParagraph(), {
                memberid: inputMemberId,
                position: cursorPosition,
                moveCursor: true
            }));
            cursorPosition += 1; // Splitting a paragraph introduces 1 walkable position, bumping the cursor forward
        });

        // Discard the last split paragraph op as unnecessary.
        // Reasoning through the scenarios, this produces the most intuitive behaviour:
        // 1. Paste a single line - No line split should be added
        // 2. Paste two lines - Only one paragraph split is necessary per new paragraph. As pasting MUST occur within an
        //                      existing paragraph, only a single split should occur.
        operations.pop();

        return operations;
    };
};
