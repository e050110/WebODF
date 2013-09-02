/**
 * Copyright (C) 2012-2013 KO GmbH <copyright@kogmbh.com>
 *
 * @licstart
 * The JavaScript code in this page is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License
 * (GNU AGPL) as published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version.  The code is distributed
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU AGPL for more details.
 *
 * As additional permission under GNU AGPL version 3 section 7, you
 * may distribute non-source (e.g., minimized or compacted) forms of
 * that code without the copy of the GNU GPL normally required by
 * section 4, provided you include this license notice and a URL
 * through which recipients can access the Corresponding Source.
 *
 * As a special exception to the AGPL, any HTML file which merely makes function
 * calls to this code, and for that purpose includes it by reference shall be
 * deemed a separate work for copyright law purposes. In addition, the copyright
 * holders of this code give you permission to combine this code with free
 * software libraries that are released under the GNU LGPL. You may copy and
 * distribute such a system following the terms of the GNU AGPL for this code
 * and the LGPL for the libraries. If you modify this code, you may extend this
 * exception to your version of the code, but you are not obligated to do so.
 * If you do not wish to do so, delete this exception statement from your
 * version.
 *
 * This license applies to this entire compilation.
 * @licend
 * @source: http://www.webodf.org/
 * @source: http://gitorious.org/webodf/webodf/
 */

/*global runtime, core, gui, Node, ops, odf */

runtime.loadClass("core.DomUtils");
runtime.loadClass("odf.OdfUtils");
runtime.loadClass("ops.OpAddCursor");
runtime.loadClass("ops.OpRemoveCursor");
runtime.loadClass("ops.OpMoveCursor");
runtime.loadClass("ops.OpInsertText");
runtime.loadClass("ops.OpRemoveText");
runtime.loadClass("ops.OpSplitParagraph");
runtime.loadClass("ops.OpSetParagraphStyle");
runtime.loadClass("ops.OpRemoveAnnotation");
runtime.loadClass("gui.ClickHandler");
runtime.loadClass("gui.Clipboard");
runtime.loadClass("gui.KeyboardHandler");
runtime.loadClass("gui.StyleHelper");

/**
 * @constructor
 * @param {!ops.Session} session
 * @param {!string} inputMemberId
 * @return {?}
 */
gui.SessionController = (function () {
    "use strict";

    /**
     * @constructor
     * @param {!ops.Session} session
     * @param {!string} inputMemberId
     * @return {?}
     */
    gui.SessionController = function SessionController(session, inputMemberId) {
        var /**@type{!Window}*/window = /**@type{!Window}*/(runtime.getWindow()),
            odtDocument = session.getOdtDocument(),
            domUtils = new core.DomUtils(),
            odfUtils = new odf.OdfUtils(),
            clipboard = new gui.Clipboard(),
            clickHandler = new gui.ClickHandler(),
            keyDownHandler = new gui.KeyboardHandler(),
            keyPressHandler = new gui.KeyboardHandler(),
            styleHelper = new gui.StyleHelper(odtDocument.getFormatting()),
            keyboardMovementsFilter = new core.PositionFilterChain(),
            baseFilter = odtDocument.getPositionFilter(),
            clickStartedWithinContainer = false,
            undoManager = null;

        runtime.assert(window !== null,
            "Expected to be run in an environment which has a global window, like a browser.");

        keyboardMovementsFilter.addFilter('BaseFilter', baseFilter);
        keyboardMovementsFilter.addFilter('RootFilter', odtDocument.createRootFilter(inputMemberId));

        /**
         * @param {!Element|!Window} eventTarget
         * @param {!string} eventType
         * @param {function(!Event)|function()} eventHandler
         * @param {boolean=} includeDirect
         * @return {undefined}
         */
        function listenEvent(eventTarget, eventType, eventHandler, includeDirect) {
            var onVariant = "on" + eventType,
                bound = false;
            if (eventTarget.attachEvent) {
                bound = eventTarget.attachEvent(onVariant, eventHandler);
            }
            if (!bound && eventTarget.addEventListener) {
                eventTarget.addEventListener(eventType, eventHandler, false);
                bound = true;
            }

            if ((!bound || includeDirect) && eventTarget.hasOwnProperty(onVariant)) {
                eventTarget[onVariant] = eventHandler;
            }
        }

        /**
         * @param {!Element|!Window} eventTarget
         * @param {!string} eventType
         * @param {function(!Event)|function()} eventHandler
         * @return {undefined}
         */
        function removeEvent(eventTarget, eventType, eventHandler) {
            var onVariant = "on" + eventType;
            if (eventTarget.detachEvent) {
                eventTarget.detachEvent(onVariant, eventHandler);
            }
            if (eventTarget.removeEventListener) {
                eventTarget.removeEventListener(eventType, eventHandler, false);
            }
            if (eventTarget[onVariant] === eventHandler) {
                eventTarget[onVariant] = null;
            }
        }

        /**
         * @param {!Event} event
         * @return {undefined}
         */
        function cancelEvent(event) {
            if (event.preventDefault) {
                event.preventDefault();
            } else {
                event.returnValue = false;
            }
        }

        /**
         * @param {!Event} e
         * @return {undefined}
         */
        function dummyHandler(e) {
            // runtime.log("ignore event " + e.type);
            cancelEvent(e);
        }

        /**
         * @param {!number} position
         * @param {!number} length
         * @return {!ops.Operation}
         */
        function createOpMoveCursor(position, length) {
            var op = new ops.OpMoveCursor();
            op.init({memberid: inputMemberId, position: position, length: length || 0});
            return op;
        }

        /**
         * @param {?Node} targetNode
         * @param {!number} targetOffset
         * @return {?number}
         */
        function countStepsToNode(targetNode, targetOffset) {
            var iterator = gui.SelectionMover.createPositionIterator(odtDocument.getRootNode()),
                canvasElement = odtDocument.getOdfCanvas().getElement(),
                node;

            // check that the node or one of its parent nodes til the canvas are
            // not belonging to a cursor, like e.g. the caret and the cursor
            // avatarflag are.
            node = targetNode;
            if (!node) {
                return null;
            }
            while (node !== canvasElement) {
                if ((node.namespaceURI === 'urn:webodf:names:cursor'
                     && node.localName === 'cursor')
                        || (node.namespaceURI === 'urn:webodf:names:editinfo'
                            && node.localName === 'editinfo')) {
                    break;
                }
                node = node.parentNode;

                // Sometimes when we click outside the canvasElement, the ancestry
                // will never reach canvasElement, and the node will eventually become null. In that case,
                // return.
                if (!node) {
                    return null;
                }
            }

            if (node !== canvasElement && targetNode !== node) {
                // This happens when the click event has been captured by a cursor or editinfo.
                // In that case, put the cursor in the capturer's container, just after it.
                targetNode = node.parentNode;
                targetOffset = Array.prototype.indexOf.call(targetNode.childNodes, node);
            }

            // create a move op with the distance to that position
            iterator.setUnfilteredPosition(targetNode, targetOffset);
            return odtDocument.getDistanceFromCursor(inputMemberId, iterator.container(), iterator.unfilteredDomOffset());
        }

        /**
         * @param {!number} x
         * @param {!number} y
         * @return {?{container:!Node, offset:!number}}
         */
        function caretPositionFromPoint(x, y) {
            var doc = odtDocument.getDOM(),
                result;

            if (doc.caretRangeFromPoint) {
                result = doc.caretRangeFromPoint(x, y);
                return {
                    container : result.startContainer,
                    offset : result.startOffset
                };
            }
            if (doc.caretPositionFromPoint) {
                result = doc.caretPositionFromPoint(x, y);
                return {
                    container : result.offsetNode,
                    offset : result.offset
                };
            }
            return null;
        }

        /**
         * @param {!Node} node
         * @return {!{node:!Node, offset:!number}}
         */
        function findClosestPosition(node) {
            var canvasElement = odtDocument.getOdfCanvas().getElement(),
                newNode = odtDocument.getRootNode(),
                newOffset = 0,
                beforeCanvas, iterator;

            /*jslint bitwise: true*/
            beforeCanvas = canvasElement.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING;
            /*jslint bitwise: false*/
            if (!beforeCanvas) {
                iterator = gui.SelectionMover.createPositionIterator(newNode);
                iterator.moveToEnd();
                newNode = iterator.container();
                newOffset = iterator.unfilteredDomOffset();
            }
            return {
                node: newNode,
                offset: newOffset
            };
        }

        /**
         * @param {!Event} e
         * @return {?{anchorNode:!Node, anchorOffset:!number, focusNode:!Node, focusOffset:!number}}
         */
        function getSelection (e) {
            var canvasElement = odtDocument.getOdfCanvas().getElement(),
                selection = window.getSelection(),
                anchorNode, anchorOffset, focusNode, focusOffset,
                anchorNodeInsideCanvas, focusNodeInsideCanvas, caretPos, node;

            if (selection.anchorNode === null && selection.focusNode === null) { // chrome & safari
                caretPos = caretPositionFromPoint(e.clientX, e.clientY);
                if (!caretPos) {
                    return null;
                }

                anchorNode = /**@type{!Node}*/(caretPos.container);
                anchorOffset = caretPos.offset;
                focusNode = anchorNode;
                focusOffset = anchorOffset;
            } else {
                anchorNode = /**@type{!Node}*/(selection.anchorNode);
                anchorOffset = selection.anchorOffset;
                focusNode = /**@type{!Node}*/(selection.focusNode);
                focusOffset = selection.focusOffset;
            }

            runtime.assert(anchorNode !== null && focusNode !== null,
                "anchorNode is null or focusNode is null");

            anchorNodeInsideCanvas = domUtils.containsNode(canvasElement, anchorNode);
            focusNodeInsideCanvas = domUtils.containsNode(canvasElement, focusNode);
            if (!anchorNodeInsideCanvas && !focusNodeInsideCanvas) {
                return null;
            }
            if (!anchorNodeInsideCanvas) {
                node = findClosestPosition(anchorNode);
                anchorNode = node.node;
                anchorOffset = node.offset;
            }
            if (!focusNodeInsideCanvas) {
                node = findClosestPosition(focusNode);
                focusNode = node.node;
                focusOffset = node.offset;
            }
            // canvas element won't have focus if user click somewhere outside the canvas then drag and
            // release click inside the canvas.
            canvasElement.focus();

            return {
                anchorNode: anchorNode,
                anchorOffset: anchorOffset,
                focusNode: focusNode,
                focusOffset: focusOffset
            };
        }

        /**
         * Returns the first filtered walkable position in the node
         * @param {!Node} node
         * @return {!number}
         */
        function getFirstWalkablePositionInNode(node) {
            var position = 0,
                iterator = gui.SelectionMover.createPositionIterator(odtDocument.getRootNode()),
                watch = new core.LoopWatchDog(1000),
                inside = false;

            while (iterator.nextPosition()) {
                watch.check();

                /*jslint bitwise: true*/
                inside = Boolean(node.compareDocumentPosition(iterator.container()) & Node.DOCUMENT_POSITION_CONTAINED_BY);

                if (baseFilter.acceptPosition(iterator) === 1) {
                    if (inside) {
                        break;
                    }
                    position += 1;
                }
            }

            return position;
        }

        /**
         * Returns the walkable length of the node
         * @param {!Node} node
         * @return {!number}
         */
        function getWalkableNodeLength(node) {
            var length = 0,
                iterator = gui.SelectionMover.createPositionIterator(odtDocument.getRootNode()),
                inside = false;

            iterator.setUnfilteredPosition(node, 0);
            do {
                /*jslint bitwise: true*/
                inside = Boolean(node.compareDocumentPosition(iterator.container()) & Node.DOCUMENT_POSITION_CONTAINED_BY);
                if (!inside && node !== iterator.container()) {
                    break;
                }
                if (baseFilter.acceptPosition(iterator) === 1) {
                    length += 1;
                }
            } while (iterator.nextPosition());

            return length;
        }

        /**
         * @param {!Node} annotationNode
         * @return {undefined}
         */
        function removeAnnotation(annotationNode) {
            var position, length, op;

            position = getFirstWalkablePositionInNode(annotationNode);
            length = getWalkableNodeLength(annotationNode);

            op = new ops.OpRemoveAnnotation();
            op.init({
                memberid: inputMemberId,
                position: position,
                length: length
            });
            session.enqueue(op);
        }

        /**
         * @param {!Event} e
         * @return {undefined}
         */
        function selectRange(e) {
            if (!clickStartedWithinContainer) {
                return;
            }

            // When click somewhere within already selected text, call window.getSelection() straight away results
            // the previous selection get returned. Set 0 timeout here so the newly clicked position can be updated
            // by the browser. Unfortunately this is only working in Firefox. For other browsers, we have to work
            // out the caret position from two coordinates.
            runtime.setTimeout(function () {
                var selection = getSelection(e),
                    oldPosition, stepsToAnchor, stepsToFocus, op;

                if (selection === null) {
                    return;
                }

                stepsToAnchor = countStepsToNode(selection.anchorNode, selection.anchorOffset);
                if (selection.focusNode === selection.anchorNode
                    && selection.focusOffset === selection.anchorOffset) {
                    stepsToFocus = stepsToAnchor;
                } else {
                    stepsToFocus = countStepsToNode(selection.focusNode, selection.focusOffset);
                }

                if ((stepsToFocus !== null && stepsToFocus !== 0 ) ||
                    (stepsToAnchor !== null && stepsToAnchor !== 0)) {
                    oldPosition = odtDocument.getCursorPosition(inputMemberId);
                    op = createOpMoveCursor(oldPosition + stepsToAnchor, stepsToFocus - stepsToAnchor);
                    session.enqueue(op);
                }
            }, 0);
        }

        function handleContextMenu(e) {
            // TODO Various browsers have different default behaviours on right click
            // We can detect this at runtime without doing any kind of platform sniffing
            // simply by observing what the browser has tried to do on right-click.
            // - OSX: Safari/Chrome - Expand to word boundary
            // - OSX: Firefox - No expansion
            // - Windows: Safari/Chrome/Firefox - No expansion
            selectRange(e);
        }
        /**
         * @param {!Node} node
         * @return {!boolean}
         */
        function isTextSpan(node) {
            return node.namespaceURI === odf.Namespaces.textns && node.localName === 'span';
        }
        /**
         * @return {undefined}
         */
        function selectWord() {
            var canvasElement = odtDocument.getOdfCanvas().getElement(),
                alphaNumeric = /[A-Za-z0-9]/,
                stepsToStart = 0,
                stepsToEnd = 0,
                iterator, cursorNode, oldPosition, currentNode, c, op;

            if (!domUtils.containsNode(canvasElement, window.getSelection().focusNode)) {
                return;
            }

            iterator = gui.SelectionMover.createPositionIterator(odtDocument.getRootNode());
            cursorNode = odtDocument.getCursor(inputMemberId).getNode();

            iterator.setUnfilteredPosition(cursorNode, 0);
            while (iterator.previousPosition()) {
                currentNode = iterator.getCurrentNode();
                if (currentNode.nodeType === Node.TEXT_NODE) {
                    c = currentNode.data[iterator.unfilteredDomOffset()];
                    if (!alphaNumeric.test(c)) {
                        break;
                    }
                    stepsToStart -= 1;
                } else if (!isTextSpan(currentNode)) {
                    break;
                }
            }

            iterator.setUnfilteredPosition(cursorNode, 0);
            do {
                currentNode = iterator.getCurrentNode();
                if (currentNode.nodeType === Node.TEXT_NODE) {
                    c = currentNode.data[iterator.unfilteredDomOffset()];
                    if (!alphaNumeric.test(c)) {
                        break;
                    }
                    stepsToEnd += 1;
                } else if (!isTextSpan(currentNode)) {
                    break;
                }
            } while (iterator.nextPosition());

            if (stepsToStart !== 0 || stepsToEnd !== 0) {
                oldPosition = odtDocument.getCursorPosition(inputMemberId);
                op = createOpMoveCursor(oldPosition + stepsToStart, Math.abs(stepsToStart) + Math.abs(stepsToEnd));
                session.enqueue(op);
            }
        }

        /**
         * @return {undefined}
         */
        function selectParagraph() {
            var canvasElement = odtDocument.getOdfCanvas().getElement(),
                iterator, paragraphNode, oldPosition, stepsToStart, stepsToEnd, op;

            if (!domUtils.containsNode(canvasElement, window.getSelection().focusNode)) {
                return;
            }

            paragraphNode = odtDocument.getParagraphElement(odtDocument.getCursor(inputMemberId).getNode());
            stepsToStart = odtDocument.getDistanceFromCursor(inputMemberId, paragraphNode, 0);
            iterator = gui.SelectionMover.createPositionIterator(odtDocument.getRootNode());
            iterator.moveToEndOfNode(paragraphNode);
            stepsToEnd = odtDocument.getDistanceFromCursor(inputMemberId, paragraphNode, iterator.unfilteredDomOffset());

            if (stepsToStart !== 0 || stepsToEnd !== 0) {
                oldPosition = odtDocument.getCursorPosition(inputMemberId);
                op = createOpMoveCursor(oldPosition + stepsToStart, Math.abs(stepsToStart) + Math.abs(stepsToEnd));
                session.enqueue(op);
            }
        }

        /**
         * @param {!number} lengthAdjust   length adjustment
         * @return {undefined}
         */
        function extendCursorByAdjustment(lengthAdjust) {
            var selection = odtDocument.getCursorSelection(inputMemberId),
                stepCounter = odtDocument.getCursor(inputMemberId).getStepCounter(),
                newLength;
            if (lengthAdjust !== 0) {
                lengthAdjust = (lengthAdjust > 0)
                    ? stepCounter.convertForwardStepsBetweenFilters(lengthAdjust, keyboardMovementsFilter, baseFilter)
                    : -stepCounter.convertBackwardStepsBetweenFilters(-lengthAdjust, keyboardMovementsFilter, baseFilter);

                newLength = selection.length + lengthAdjust;
                session.enqueue(createOpMoveCursor(selection.position, newLength));
            }
        }

        /**
         * @param {!number} positionAdjust   position adjustment
         * @return {undefined}
         */
        function moveCursorByAdjustment(positionAdjust) {
            var position = odtDocument.getCursorPosition(inputMemberId),
                stepCounter = odtDocument.getCursor(inputMemberId).getStepCounter();
            if (positionAdjust !== 0) {
                positionAdjust = (positionAdjust > 0)
                    ? stepCounter.convertForwardStepsBetweenFilters(positionAdjust, keyboardMovementsFilter, baseFilter)
                    : -stepCounter.convertBackwardStepsBetweenFilters(-positionAdjust, keyboardMovementsFilter, baseFilter);

                position = position + positionAdjust;
                session.enqueue(createOpMoveCursor(position, 0));
            }
        }

        /**
         * @return {!boolean}
         */
        function moveCursorToLeft() {
            moveCursorByAdjustment(-1);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function moveCursorToRight() {
            moveCursorByAdjustment(1);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionToLeft() {
            extendCursorByAdjustment(-1);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionToRight() {
            extendCursorByAdjustment(1);
            return true;
        }

        /**
         * @param {!number} direction -1 for upwards 1 for downwards
         * @param {!boolean} extend
         * @return {undefined}
         */
        function moveCursorByLine(direction, extend) {
            var paragraphNode = odtDocument.getParagraphElement(odtDocument.getCursor(inputMemberId).getNode()),
                steps;

            runtime.assert(Boolean(paragraphNode), "SessionController: Cursor outside paragraph");
            steps = odtDocument.getCursor(inputMemberId).getStepCounter().countLinesSteps(direction, keyboardMovementsFilter);
            if (extend) {
                extendCursorByAdjustment(steps);
            } else {
                moveCursorByAdjustment(steps);
            }
        }

        /**
         * @return {!boolean}
         */
        function moveCursorUp() {
            moveCursorByLine(-1, false);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function moveCursorDown() {
            moveCursorByLine(1, false);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionUp() {
            moveCursorByLine(-1, true);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionDown() {
            moveCursorByLine(1, true);
            return true;
        }

        /**
         * @param {!number} direction -1 for beginning 1 for end
         * @param {!boolean} extend
         * @return {undefined}
         */
        function moveCursorToLineBoundary(direction, extend) {
            var steps = odtDocument.getCursor(inputMemberId).getStepCounter().countStepsToLineBoundary(
                direction,
                keyboardMovementsFilter
            );
            if (extend) {
                extendCursorByAdjustment(steps);
            } else {
                moveCursorByAdjustment(steps);
            }
        }

        /**
         * @return {!boolean}
         */
        function moveCursorToLineStart() {
            moveCursorToLineBoundary(-1, false);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function moveCursorToLineEnd() {
            moveCursorToLineBoundary(1, false);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionToLineStart() {
            moveCursorToLineBoundary(-1, true);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionToLineEnd() {
            moveCursorToLineBoundary(1, true);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionToParagraphStart() {
            var paragraphNode = odtDocument.getParagraphElement(odtDocument.getCursor(inputMemberId).getNode()),
                iterator,
                node,
                steps;

            runtime.assert(Boolean(paragraphNode), "SessionController: Cursor outside paragraph");
            steps = odtDocument.getDistanceFromCursor(inputMemberId, paragraphNode, 0);
            iterator = gui.SelectionMover.createPositionIterator(odtDocument.getRootNode());
            iterator.setUnfilteredPosition(paragraphNode, 0);

            while (steps === 0 && iterator.previousPosition()) {
                node = iterator.getCurrentNode();

                if (odfUtils.isParagraph(node)) {
                    steps = odtDocument.getDistanceFromCursor(inputMemberId, node, 0);
                }
            }
            extendCursorByAdjustment(steps);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionToParagraphEnd() {
            var paragraphNode = odtDocument.getParagraphElement(odtDocument.getCursor(inputMemberId).getNode()),
                iterator,
                node,
                steps;

            runtime.assert(Boolean(paragraphNode), "SessionController: Cursor outside paragraph");
            iterator = gui.SelectionMover.createPositionIterator(odtDocument.getRootNode());
            iterator.moveToEndOfNode(paragraphNode);
            steps = odtDocument.getDistanceFromCursor(
                inputMemberId,
                iterator.container(),
                iterator.unfilteredDomOffset()
            );

            while (steps === 0 && iterator.nextPosition()) {
                node = iterator.getCurrentNode();

                if (odfUtils.isParagraph(node)) {
                    iterator.moveToEndOfNode(node);
                    steps = odtDocument.getDistanceFromCursor(
                        inputMemberId,
                        iterator.container(),
                        iterator.unfilteredDomOffset()
                    );
                }
            }
            extendCursorByAdjustment(steps);
            return true;
        }

        /**
         * @param {!number} direction -1 for beginning, 1 for end
         * @param {!boolean=} extend
         * @return {undefined}
         */
        function moveCursorToDocumentBoundary(direction, extend) {
            var iterator = gui.SelectionMover.createPositionIterator(odtDocument.getRootNode()),
                steps;
            if (direction > 0) {
                iterator.moveToEnd();
            }

            steps = odtDocument.getDistanceFromCursor(
                inputMemberId,
                iterator.container(),
                iterator.unfilteredDomOffset()
            );
            if (extend) {
                extendCursorByAdjustment(steps);
            } else {
                moveCursorByAdjustment(steps);
            }
        }

        /**
         * @return {!boolean}
         */
        function moveCursorToDocumentStart() {
            moveCursorToDocumentBoundary(-1, false);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function moveCursorToDocumentEnd() {
            moveCursorToDocumentBoundary(1, false);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionToDocumentStart() {
            moveCursorToDocumentBoundary(-1, true);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionToDocumentEnd() {
            moveCursorToDocumentBoundary(1, true);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function extendSelectionToEntireDocument() {
            var iterator = gui.SelectionMover.createPositionIterator(odtDocument.getRootNode()),
                steps;
            // The root node is always before the cursor, therefore the returned number of steps is always negative
            steps = -odtDocument.getDistanceFromCursor(inputMemberId, iterator.container(), iterator.unfilteredDomOffset());

            iterator.moveToEnd();
            steps += odtDocument.getDistanceFromCursor(inputMemberId, iterator.container(), iterator.unfilteredDomOffset());
            session.enqueue(createOpMoveCursor(0, steps));
            return true;
        }

        /**
         * Ensures the provided selection is a "forward" selection (i.e., length is positive)
         * @param {!{position: number, length: number}} selection
         * @returns {!{position: number, length: number}}
         */
        function toForwardSelection(selection) {
            if (selection.length < 0) {
                selection.position += selection.length;
                selection.length = -selection.length;
            }
            return selection;
        }

        /**
         * Creates an operation to remove the provided selection
         * @param {!{position: number, length: number}} selection
         * @returns {!ops.OpRemoveText}
         */
        function createOpRemoveSelection(selection) {
            var op = new ops.OpRemoveText();
            op.init({
                memberid: inputMemberId,
                position: selection.position,
                length: selection.length
            });
            return op;
        }

        /**
         * @return {!boolean}
         */
        function removeTextByBackspaceKey() {
            var selection = toForwardSelection(odtDocument.getCursorSelection(inputMemberId)),
                op = null;

            if (selection.length === 0) {
                // position-1 must exist for backspace to be valid
                if (selection.position > 0 && odtDocument.getPositionInTextNode(selection.position - 1)) {
                    op = new ops.OpRemoveText();
                    op.init({
                        memberid: inputMemberId,
                        position: selection.position - 1,
                        length: 1
                    });
                    session.enqueue(op);
                }
            } else {
                op = createOpRemoveSelection(selection);
                session.enqueue(op);
            }
            return true;
        }
        /**
         * @return {!boolean}
         */
        function removeTextByDeleteKey() {
            var selection = toForwardSelection(odtDocument.getCursorSelection(inputMemberId)),
                op = null;

            if (selection.length === 0) {
                // position+1 must exist for delete to be valid
                if (odtDocument.getPositionInTextNode(selection.position + 1)) {
                    op = new ops.OpRemoveText();
                    op.init({
                        memberid: inputMemberId,
                        position: selection.position,
                        length: 1
                    });
                    session.enqueue(op);
                }
            } else {
                op = createOpRemoveSelection(selection);
                session.enqueue(op);
            }
            return op !== null;
        }
        /**
         * @return {!boolean}
         */
        function removeTextByClearKey() {
            var selection = toForwardSelection(odtDocument.getCursorSelection(inputMemberId));
            if (selection.length !== 0) {
                session.enqueue(createOpRemoveSelection(selection));
            }
            return true;
        }
        /**
         * Removes currently selected text (if any) before inserts the text.
         * @param {!string} text
         * @return {undefined}
         */
        function insertText(text) {
            var selection = toForwardSelection(odtDocument.getCursorSelection(inputMemberId)),
                op = null;

            if (selection.length > 0) {
                op = createOpRemoveSelection(selection);
                session.enqueue(op);
            }

            op = new ops.OpInsertText();
            op.init({
                memberid: inputMemberId,
                position: selection.position,
                text: text
            });
            session.enqueue(op);
        }

        /**
         * @return {!boolean}
         */
        function enqueueParagraphSplittingOps() {
            var position = odtDocument.getCursorPosition(inputMemberId),
                op;

            op = new ops.OpSplitParagraph();
            op.init({
                memberid: inputMemberId,
                position: position
            });
            session.enqueue(op);

            // disabled for now, because nowjs seems to revert the order of the ops, which does not work here TODO: grouping of ops
            /*
             if (isAtEndOfParagraph) {
             paragraphNode = odtDocument.getParagraphElement(odtDocument.getCursor(inputMemberId).getNode());
             styleName = odtDocument.getFormatting().getParagraphStyleAttribute(styleName, odf.Namespaces.stylens, 'next-style-name');

             if (nextStyleName && nextStyleName !== styleName) {
             op = new ops.OpSetParagraphStyle();
             op.init({
             memberid: inputMemberId,
             position: position + 1, // +1 should be at the start of the new paragraph
             styleName: styleName
             });
             session.enqueue(op);
             }
             }
             */

            return true;
        }
        /**
         * TODO: This method and associated event subscriptions really belong in SessionView
         * As this implementation relies on the current browser selection, only a single
         * cursor can be highlighted at a time. Eventually, when virtual selection & cursors are
         * implemented, this limitation will be eliminated
         * @return {undefined}
         */
        function maintainCursorSelection() {
            var cursor = odtDocument.getCursor(inputMemberId),
                selection = window.getSelection();

            if (cursor) {
                // May have just processed our own remove cursor operation...
                // Probably not a good idea to try and update our selected range in this case ;-)
                selection.removeAllRanges();
                selection.addRange(cursor.getSelectedRange().cloneRange());
            }
        }

        /**
         * @param {!Event} event
         * @return {?string}
         */
        function stringFromKeyPress(event) {
            if (event.which === null) {
                return String.fromCharCode(event.keyCode); // IE
            }
            if (event.which !== 0 && event.charCode !== 0) {
                return String.fromCharCode(event.which);   // the rest
            }
            return null; // special key
        }

        /**
         * Handle the cut operation request
         * @param {!Event} e
         * @return {undefined}
         */
        function handleCut(e) {
            var cursor = odtDocument.getCursor(inputMemberId),
                selectedRange = cursor.getSelectedRange(),
                selection,
                op;

            if (selectedRange.collapsed) {
                // Modifying the clipboard data will clear any existing data,
                // so cut shouldn't touch the clipboard if there is nothing selected
                return;
            }

            // The document is readonly, so the data will never get placed on the clipboard in
            // most browsers unless we do it ourselves.
            if (clipboard.setDataFromRange(e, cursor.getSelectedRange())) {
                op = new ops.OpRemoveText();
                selection = toForwardSelection(session.getOdtDocument().getCursorSelection(inputMemberId));
                op.init({
                    memberid: inputMemberId,
                    position: selection.position,
                    length: selection.length
                });
                session.enqueue(op);
            } else {
                // TODO What should we do if cut isn't supported?
                runtime.log("Cut operation failed");
            }
        }

        /**
         * Tell the browser that it's ok to perform a cut action on our read-only body
         * @returns {!boolean}
         */
        function handleBeforeCut() {
            var cursor = odtDocument.getCursor(inputMemberId),
                selectedRange = cursor.getSelectedRange();
            return selectedRange.collapsed !== false; // return false to enable cut menu... straightforward right?!
        }

        /**
         * Handle the copy operation request
         * @param {!Event} e
         * @return {undefined}
         */
        function handleCopy(e) {
            var cursor = odtDocument.getCursor(inputMemberId),
                selectedRange = cursor.getSelectedRange();

            if (selectedRange.collapsed) {
                // Modifying the clipboard data will clear any existing data,
                // so cut shouldn't touch the clipboard if there is nothing selected
                return;
            }

            // Place the data on the clipboard ourselves to ensure consistency with cut behaviours
            if (!clipboard.setDataFromRange(e, cursor.getSelectedRange())) {
                // TODO What should we do if cut isn't supported?
                runtime.log("Cut operation failed");
            }
        }

        /**
         * @param {!Event} e
         * @return {undefined}
         */
        function handlePaste(e) {
            var plainText;

            if (window.clipboardData && window.clipboardData.getData) { // IE
                plainText = window.clipboardData.getData('Text');
            } else if (e.clipboardData && e.clipboardData.getData) { // the rest
                plainText = e.clipboardData.getData('text/plain');
            }

            if (plainText) {
                insertText(plainText);
                cancelEvent(e);
            }
        }

        /**
         * Tell the browser that it's ok to perform a paste action on our read-only body
         * @returns {!boolean}
         */
        function handleBeforePaste() {
            return false;
        }

        /**
         * @param {!ops.Operation} op
         * @return {undefined}
         */
        function updateUndoStack(op) {
            if (undoManager) {
                undoManager.onOperationExecuted(op);
            }
        }

        /**
         * @param {?Event} e
         * @return {undefined}
         */
        function forwardUndoStackChange(e) {
            odtDocument.emit(ops.OdtDocument.signalUndoStackChanged, e);
        }

        /**
         * @return {!boolean}
         */
        function undo() {
            if (undoManager) {
                undoManager.moveBackward(1);
                maintainCursorSelection();
                return true;
            }

            return false;
        }

        /**
         * @return {!boolean}
         */
        function redo() {
            if (undoManager) {
                undoManager.moveForward(1);
                maintainCursorSelection();
                return true;
            }

            return false;
        }

        // duplicate of EditorSession.formatSelection method
        // TODO: find a better place for this method to live so it can be reused
        /**
         * @param {!string} propertyName
         * @param {!string} propertyValue
         * @return {undefined}
         */
        function formatTextSelection(propertyName, propertyValue) {
            var selection = odtDocument.getCursorSelection(inputMemberId),
                op = new ops.OpApplyDirectStyling(),
                properties = {};

            properties[propertyName] = propertyValue;
            op.init({
                memberid: inputMemberId,
                position: selection.position,
                length: selection.length,
                setProperties: {'style:text-properties' : properties }
            });
            session.enqueue(op);
        }

        /**
         * @return {!boolean}
         */
        function toggleBold() {
            var range = odtDocument.getCursor(inputMemberId).getSelectedRange(),
                value = styleHelper.isBold(range) ? 'normal' : 'bold';
            formatTextSelection('fo:font-weight', value);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function toggleItalic() {
            var range = odtDocument.getCursor(inputMemberId).getSelectedRange(),
                value = styleHelper.isItalic(range) ? 'normal' : 'italic';
            formatTextSelection('fo:font-style', value);
            return true;
        }

        /**
         * @return {!boolean}
         */
        function toggleUnderline() {
            var range = odtDocument.getCursor(inputMemberId).getSelectedRange(),
                value = styleHelper.hasUnderline(range) ? 'none' : 'solid';
            formatTextSelection('style:text-underline-style', value);
            return true;
        }

        /**
         * Updates a flag indicating whether the mouse down event occurred within the OdfCanvas element.
         * This is necessary because the mouse-up binding needs to be global in order to handle mouse-up
         * events that occur when the user releases the mouse button outside the canvas.
         * This filter limits selection changes to mouse down events that start inside the canvas
         * @param e
         */
        function filterMouseClicks(e) {
            clickStartedWithinContainer = e.target && domUtils.containsNode(odtDocument.getOdfCanvas().getElement(), e.target);
        }

        /**
         * @return {undefined}
         */
        this.startEditing = function () {
            var canvasElement, op;

            canvasElement = odtDocument.getOdfCanvas().getElement();
            listenEvent(canvasElement, "keydown", keyDownHandler.handleEvent);
            listenEvent(canvasElement, "keypress", keyPressHandler.handleEvent);
            listenEvent(canvasElement, "keyup", dummyHandler);
            // In Safari 6.0.5 (7536.30.1), Using either attachEvent or addEventListener
            // results in the beforecut return value being ignored which prevents cut from being called.
            listenEvent(canvasElement, "beforecut", handleBeforeCut, true);
            listenEvent(canvasElement, "cut", handleCut);
            listenEvent(canvasElement, "copy", handleCopy);
            // Epiphany 3.6.1 requires this to allow the paste event to fire
            listenEvent(canvasElement, "beforepaste", handleBeforePaste, true);
            listenEvent(canvasElement, "paste", handlePaste);
            listenEvent(window, "mousedown", filterMouseClicks);
            listenEvent(window, "mouseup", clickHandler.handleMouseUp);
            listenEvent(canvasElement, "contextmenu", handleContextMenu);

            // start maintaining the cursor selection now
            odtDocument.subscribe(ops.OdtDocument.signalOperationExecuted, maintainCursorSelection);
            odtDocument.subscribe(ops.OdtDocument.signalOperationExecuted, updateUndoStack);

            op = new ops.OpAddCursor();
            op.init({memberid: inputMemberId});
            session.enqueue(op);

            if (undoManager) {
                // For most undo managers, the initial state is a clean document *with* a cursor present
                undoManager.saveInitialState();
            }
        };

        /**
         * @return {undefined}
         */
        this.endEditing = function () {
            var canvasElement, op;

            odtDocument.unsubscribe(ops.OdtDocument.signalOperationExecuted, updateUndoStack);
            odtDocument.unsubscribe(ops.OdtDocument.signalOperationExecuted, maintainCursorSelection);

            canvasElement = odtDocument.getOdfCanvas().getElement();
            removeEvent(canvasElement, "keydown", keyDownHandler.handleEvent);
            removeEvent(canvasElement, "keypress", keyPressHandler.handleEvent);
            removeEvent(canvasElement, "keyup", dummyHandler);
            removeEvent(canvasElement, "cut", handleCut);
            removeEvent(canvasElement, "beforecut", handleBeforeCut);
            removeEvent(canvasElement, "copy", handleCopy);
            removeEvent(canvasElement, "paste", handlePaste);
            removeEvent(canvasElement, "beforepaste", handleBeforePaste);
            removeEvent(window, "mousedown", filterMouseClicks);
            removeEvent(window, "mouseup", clickHandler.handleMouseUp);
            removeEvent(canvasElement, "contextmenu", handleContextMenu);

            op = new ops.OpRemoveCursor();
            op.init({memberid: inputMemberId});
            session.enqueue(op);

            if (undoManager) {
                undoManager.resetInitialState();
            }
        };

        /**
         * @return {!string}
         */
        this.getInputMemberId = function () {
            return inputMemberId;
        };

        /**
         * @return {!ops.Session}
         */
        this.getSession = function () {
            return session;
        };

        /**
         * @param {?gui.UndoManager} manager
         * @return {undefined}
         */
        this.setUndoManager = function (manager) {
            if (undoManager) {
                undoManager.unsubscribe(gui.UndoManager.signalUndoStackChanged, forwardUndoStackChange);
            }

            undoManager = manager;
            if (undoManager) {
                undoManager.setOdtDocument(odtDocument);
                // As per gui.UndoManager, this should NOT fire any signals or report
                // events being executed back to the undo manager.
                undoManager.setPlaybackFunction(function (op) {
                    op.execute(odtDocument);
                });
                undoManager.subscribe(gui.UndoManager.signalUndoStackChanged, forwardUndoStackChange);
            }
        };

        /**
         * @returns {?gui.UndoManager}
         */
        this.getUndoManager = function () {
            return undoManager;
        };

        /**
         * @param {!function(!Object=)} callback, passing an error object in case of error
         * @return {undefined}
         */
        this.destroy = function(callback) {
            // TODO: check if anything needs to be cleaned up
            callback();
        };

        function init() {
            var isMacOS = window.navigator.appVersion.toLowerCase().indexOf("mac") !== -1,
                modifier = gui.KeyboardHandler.Modifier,
                keyCode = gui.KeyboardHandler.KeyCode;

            keyDownHandler.bind(keyCode.Tab, modifier.None, function () {
                insertText("\t");
                return true;
            });
            keyDownHandler.bind(keyCode.Left, modifier.None, moveCursorToLeft);
            keyDownHandler.bind(keyCode.Right, modifier.None, moveCursorToRight);
            keyDownHandler.bind(keyCode.Up, modifier.None, moveCursorUp);
            keyDownHandler.bind(keyCode.Down, modifier.None, moveCursorDown);
            keyDownHandler.bind(keyCode.Backspace, modifier.None, removeTextByBackspaceKey);
            keyDownHandler.bind(keyCode.Delete, modifier.None, removeTextByDeleteKey);
            keyDownHandler.bind(keyCode.Left, modifier.Shift, extendSelectionToLeft);
            keyDownHandler.bind(keyCode.Right, modifier.Shift, extendSelectionToRight);
            keyDownHandler.bind(keyCode.Up, modifier.Shift, extendSelectionUp);
            keyDownHandler.bind(keyCode.Down, modifier.Shift, extendSelectionDown);

            keyDownHandler.bind(keyCode.Home, modifier.None, moveCursorToLineStart);
            keyDownHandler.bind(keyCode.End, modifier.None, moveCursorToLineEnd);
            keyDownHandler.bind(keyCode.Home, modifier.Ctrl, moveCursorToDocumentStart);
            keyDownHandler.bind(keyCode.End, modifier.Ctrl, moveCursorToDocumentEnd);
            keyDownHandler.bind(keyCode.Home, modifier.Shift, extendSelectionToLineStart);
            keyDownHandler.bind(keyCode.End, modifier.Shift, extendSelectionToLineEnd);
            keyDownHandler.bind(keyCode.Up, modifier.CtrlShift, extendSelectionToParagraphStart);
            keyDownHandler.bind(keyCode.Down, modifier.CtrlShift, extendSelectionToParagraphEnd);
            keyDownHandler.bind(keyCode.Home, modifier.CtrlShift, extendSelectionToDocumentStart);
            keyDownHandler.bind(keyCode.End, modifier.CtrlShift, extendSelectionToDocumentEnd);

            if (isMacOS) {
                keyDownHandler.bind(keyCode.Clear, modifier.None, removeTextByClearKey);
                keyDownHandler.bind(keyCode.Left, modifier.Meta, moveCursorToLineStart);
                keyDownHandler.bind(keyCode.Right, modifier.Meta, moveCursorToLineEnd);
                keyDownHandler.bind(keyCode.Home, modifier.Meta, moveCursorToDocumentStart);
                keyDownHandler.bind(keyCode.End, modifier.Meta, moveCursorToDocumentEnd);
                keyDownHandler.bind(keyCode.Left, modifier.MetaShift, extendSelectionToLineStart);
                keyDownHandler.bind(keyCode.Right, modifier.MetaShift, extendSelectionToLineEnd);
                keyDownHandler.bind(keyCode.Up, modifier.AltShift, extendSelectionToParagraphStart);
                keyDownHandler.bind(keyCode.Down, modifier.AltShift, extendSelectionToParagraphEnd);
                keyDownHandler.bind(keyCode.Up, modifier.MetaShift, extendSelectionToDocumentStart);
                keyDownHandler.bind(keyCode.Down, modifier.MetaShift, extendSelectionToDocumentEnd);
                keyDownHandler.bind(keyCode.A, modifier.Meta, extendSelectionToEntireDocument);
                keyDownHandler.bind(keyCode.B, modifier.Meta, toggleBold);
                keyDownHandler.bind(keyCode.I, modifier.Meta, toggleItalic);
                keyDownHandler.bind(keyCode.U, modifier.Meta, toggleUnderline);
                keyDownHandler.bind(keyCode.Z, modifier.Meta, undo);
                keyDownHandler.bind(keyCode.Z, modifier.MetaShift, redo);
            } else {
                keyDownHandler.bind(keyCode.A, modifier.Ctrl, extendSelectionToEntireDocument);
                keyDownHandler.bind(keyCode.B, modifier.Ctrl, toggleBold);
                keyDownHandler.bind(keyCode.I, modifier.Ctrl, toggleItalic);
                keyDownHandler.bind(keyCode.U, modifier.Ctrl, toggleUnderline);
                keyDownHandler.bind(keyCode.Z, modifier.Ctrl, undo);
                keyDownHandler.bind(keyCode.Z, modifier.CtrlShift, redo);
            }

            // the default action is to insert text into the document
            keyPressHandler.setDefault(function (e) {
                var text = stringFromKeyPress(e);
                if (text && !(e.altKey || e.ctrlKey || e.metaKey)) {
                    insertText(text);
                    return true;
                }
                return false;
            });
            keyPressHandler.bind(keyCode.Enter, modifier.None, enqueueParagraphSplittingOps);

            clickHandler.subscribe(gui.ClickHandler.signalSingleClick, function (event) {
                var target = event.target,
                    annotationNode = null;
                if (target.className === "annotationRemoveButton") {
                    annotationNode = domUtils.getElementsByTagNameNS(target.parentNode, odf.Namespaces.officens, 'annotation')[0];
                    removeAnnotation(annotationNode);
                } else {
                    selectRange(event);
                }
            });
            clickHandler.subscribe(gui.ClickHandler.signalDoubleClick, selectWord);
            clickHandler.subscribe(gui.ClickHandler.signalTripleClick, selectParagraph);
        }

        init();
    };

    return gui.SessionController;
}());
// vim:expandtab
