const {eq, schema, doc, p} = require("prosemirror-test-builder")
const {EditorState, Plugin, TextSelection} = require("prosemirror-state")
const ist = require("ist")

const {history, closeHistory, undo, redo, undoDepth} = require("../dist/history")

let plugin = history()

function mkState(doc, config) {
  let plugins = [config ? history(config) : plugin]
  if (config && config.preserveItems) plugins.push(new Plugin({historyPreserveItems: true}))
  return EditorState.create({schema, plugins, doc})
}

function type(state, text) {
  return state.apply(state.tr.insertText(text))
}
function command(state, command) {
  command(state, tr => state = state.apply(tr))
  return state
}

function compress(state) {
  // NOTE: This is mutating stuff that shouldn't be mutated. Not safe
  // to do outside of these tests.
  plugin.getState(state).done = plugin.getState(state).done.compress()
}

describe("history", () => {
  it("enables undo", () => {
    let state = mkState()
    state = type(state, "a")
    state = type(state, "b")
    ist(state.doc, doc(p("ab")), eq)
    state = command(state, undo)
    ist(state.doc, doc(p()), eq)
  })

  it("enables redo", () => {
    let state = mkState()
    state = type(state, "a")
    state = type(state, "b")
    state = command(state, undo)
    ist(state.doc, doc(p()), eq)
    state = command(state, redo)
    ist(state.doc, doc(p("ab")), eq)
  })

  it("tracks multiple levels of history", () => {
    let state = mkState()
    state = type(state, "a")
    state = type(state, "b")
    state = state.apply(state.tr.insertText("c", 1))
    ist(state.doc, doc(p("cab")), eq)
    state = command(state, undo)
    ist(state.doc, doc(p("ab")), eq)
    state = command(state, undo)
    ist(state.doc, doc(p()), eq)
    state = command(state, redo)
    ist(state.doc, doc(p("ab")), eq)
    state = command(state, redo)
    ist(state.doc, doc(p("cab")), eq)
    state = command(state, undo)
    ist(state.doc, doc(p("ab")), eq)
  })

  it("starts a new event when newGroupDelay elapses", () => {
    let state = mkState(null, {newGroupDelay: 1000})
    state = state.apply(state.tr.insertText("a").setTime(1000))
    state = state.apply(state.tr.insertText("b").setTime(1600))
    ist(undoDepth(state), 1)
    state = state.apply(state.tr.insertText("c").setTime(2700))
    ist(undoDepth(state), 2)
    state = command(state, undo)
    state = state.apply(state.tr.insertText("d").setTime(2800))
    ist(undoDepth(state), 2)
  })

  it("allows changes that aren't part of the history", () => {
    let state = mkState()
    state = type(state, "hello")
    state = state.apply(state.tr.insertText("oops", 1).setMeta("addToHistory", false))
    state = state.apply(state.tr.insertText("!", 10).setMeta("addToHistory", false))
    state = command(state, undo)
    ist(state.doc, doc(p("oops!")), eq)
  })

  it("doesn't get confused by an undo not adding any redo item", () => {
    let state = mkState()
    state = state.apply(state.tr.insertText("foo"))
    state = state.apply(state.tr.replaceWith(1, 4, schema.text("bar")).setMeta("addToHistory", false))
    state = command(state, undo)
    state = command(state, redo)
    ist(state.doc, doc(p("bar")), eq)
  })

  function unsyncedComplex(state, doCompress) {
    state = type(state, "hello")
    state = state.apply(closeHistory(state.tr))
    state = type(state, "!")
    state = state.apply(state.tr.insertText("....", 1).setMeta("addToHistory", false))
    state = state.apply(state.tr.split(3))
    ist(state.doc, doc(p(".."), p("..hello!")), eq)
    state = state.apply(state.tr.split(2).setMeta("addToHistory", false))
    if (doCompress) compress(state)
    state = command(state, undo)
    state = command(state, undo)
    ist(state.doc, doc(p("."), p("...hello")), eq)
    state = command(state, undo)
    ist(state.doc, doc(p("."), p("...")), eq)
  }

  it("can handle complex editing sequences", () => {
    unsyncedComplex(mkState(), false)
  })

  it("can handle complex editing sequences with compression", () => {
    unsyncedComplex(mkState(), true)
  })

  it("supports overlapping edits", () => {
    let state = mkState()
    state = type(state, "hello")
    state = state.apply(closeHistory(state.tr))
    state = state.apply(state.tr.delete(1, 6))
    ist(state.doc, doc(p()), eq)
    state = command(state, undo)
    ist(state.doc, doc(p("hello")), eq)
    state = command(state, undo)
    ist(state.doc, doc(p()), eq)
  })

  it("supports overlapping edits that aren't collapsed", () => {
    let state = mkState()
    state = state.apply(state.tr.insertText("h", 1).setMeta("addToHistory", false))
    state = type(state, "ello")
    state = state.apply(closeHistory(state.tr))
    state = state.apply(state.tr.delete(1, 6))
    ist(state.doc, doc(p()), eq)
    state = command(state, undo)
    ist(state.doc, doc(p("hello")), eq)
    state = command(state, undo)
    ist(state.doc, doc(p("h")), eq)
  })

  it("supports overlapping unsynced deletes", () => {
    let state = mkState()
    state = type(state, "hi")
    state = state.apply(closeHistory(state.tr))
    state = type(state, "hello")
    state = state.apply(state.tr.delete(1, 8).setMeta("addToHistory", false))
    ist(state.doc, doc(p()), eq)
    state = command(state, undo)
    ist(state.doc, doc(p()), eq)
  })

  it("can go back and forth through history multiple times", () => {
    let state = mkState()
    state = type(state, "one")
    state = type(state, " two")
    state = state.apply(closeHistory(state.tr))
    state = type(state, " three")
    state = state.apply(state.tr.insertText("zero ", 1))
    state = state.apply(closeHistory(state.tr))
    state = state.apply(state.tr.split(1))
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)))
    state = type(state, "top")
    for (let i = 0; i < 6; i++) {
      let re = i % 2
      for (let j = 0; j < 4; j++) state = command(state, re ? redo : undo)
      ist(state.doc, re ? doc(p("top"), p("zero one two three")) : doc(p()), eq)
    }
  })

  it("supports non-tracked changes next to tracked changes", () => {
    let state = mkState()
    state = type(state, "o")
    state = state.apply(state.tr.split(1))
    state = state.apply(state.tr.insertText("zzz", 4).setMeta("addToHistory", false))
    state = command(state, undo)
    ist(state.doc, doc(p("zzz")), eq)
  })

  it("can go back and forth through history when preserving items", () => {
    let state = mkState()
    state = type(state, "one")
    state = type(state, " two")
    state = state.apply(closeHistory(state.tr))
    state = state.apply(state.tr.insertText("xxx", state.selection.head).setMeta("addToHistory", false))
    state = type(state, " three")
    state = state.apply(state.tr.insertText("zero ", 1))
    state = state.apply(closeHistory(state.tr))
    state = state.apply(state.tr.split(1))
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)))
    state = type(state, "top")
    state = state.apply(state.tr.insertText("yyy", 1).setMeta("addToHistory", false))
    for (let i = 0; i < 3; i++) {
      if (i == 2) compress(state)
      for (let j = 0; j < 4; j++) state = command(state, undo)
      ist(state.doc, doc(p("yyyxxx")), eq)
      for (let j = 0; j < 4; j++) state = command(state, redo)
      ist(state.doc, doc(p("yyytop"), p("zero one twoxxx three")), eq)
    }
  })

  it("restores selection on undo", () => {
    let state = mkState()
    state = type(state, "hi")
    state = state.apply(closeHistory(state.tr))
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)))
    let selection = state.selection
    state = state.apply(state.tr.replaceWith(selection.from, selection.to, schema.text("hello")))
    let selection2 = state.selection
    state = command(state, undo)
    ist(state.selection.eq(selection))
    state = command(state, redo)
    ist(state.selection.eq(selection2))
  })

  it("rebases selection on undo", () => {
    let state = mkState()
    state = type(state, "hi")
    state = state.apply(closeHistory(state.tr))
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)))
    state = state.apply(state.tr.insert(1, schema.text("hello")))
    state = state.apply(state.tr.insert(1, schema.text("---")).setMeta("addToHistory", false))
    state = command(state, undo)
    ist(state.selection.head, 6)
  })

  it("handles change overwriting in item-preserving mode", () => {
    let state = mkState(null, {preserveItems: true})
    state = type(state, "a")
    state = type(state, "b")
    state = state.apply(closeHistory(state.tr))
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)))
    state = type(state, "c")
    state = command(state, undo)
    state = command(state, undo)
    ist(state.doc, doc(p()), eq)
  })
})
