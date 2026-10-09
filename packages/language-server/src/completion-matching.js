"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchesCompletionName = void 0;
function matchesCompletionName(name, search) {
    const normalized = name.toLowerCase();
    let position = 0;
    for (const character of search.toLowerCase()) {
        position = normalized.indexOf(character, position);
        if (position < 0)
            return false;
        position++;
    }
    return true;
}
exports.matchesCompletionName = matchesCompletionName;
//# sourceMappingURL=completion-matching.js.map