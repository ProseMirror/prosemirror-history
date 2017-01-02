const {eq, schema, doc, p} = require("prosemirror-model/test/build")
const {TestState} = require("prosemirror-state/test/state")
const ist = require("ist")

const {history, closeHistory, undo, redo, undoDepth} = require("../dist/history")

let plugin = history()

function mkState(doc, config) {
  return new TestState({doc, schema, plugins: [config ? history(config) : plugin]})
}

function compress(state) {
  // NOTE: This is mutating stuff that shouldn't be mutated. Not safe
  // to do outside of these tests.
  plugin.getState(state.state).done = plugin.getState(state.state).done.compress()
}

describe("history", () => {
  it("enables undo", () => {
    let state = mkState()
    state.type("a")
    state.type("b")
    ist(state.doc, doc(p("ab")), eq)
    state.command(undo)
    ist(state.doc, doc(p()), eq)
  })

  it("enables redo", () => {
    let state = mkState()
    state.type("a")
    state.type("b")
    state.command(undo)
    ist(state.doc, doc(p()), eq)
    state.command(redo)
    ist(state.doc, doc(p("ab")), eq)
  })

  it("tracks multiple levels of history", () => {
    let state = mkState()
    state.type("a")
    state.type("b")
    state.apply(state.tr.insertText("c", 1))
    ist(state.doc, doc(p("cab")), eq)
    state.command(undo)
    ist(state.doc, doc(p("ab")), eq)
    state.command(undo)
    ist(state.doc, doc(p()), eq)
    state.command(redo)
    ist(state.doc, doc(p("ab")), eq)
    state.command(redo)
    ist(state.doc, doc(p("cab")), eq)
    state.command(undo)
    ist(state.doc, doc(p("ab")), eq)
  })

  it("starts a new event when newGroupDelay elapses", () => {
    let state = mkState(null, {newGroupDelay: 1000})
    state.apply(state.tr.insertText("a").setTime(1000))
    state.apply(state.tr.insertText("b").setTime(1600))
    ist(undoDepth(state.state), 1)
    state.apply(state.tr.insertText("c").setTime(2700))
    ist(undoDepth(state.state), 2)
    state.command(undo)
    state.apply(state.tr.insertText("d").setTime(2800))
    ist(undoDepth(state.state), 2)
  })

  it("allows changes that aren't part of the history", () => {
    let state = mkState()
    state.type("hello")
    state.apply(state.tr.insertText("oops", 1).set("addToHistory", false))
    state.apply(state.tr.insertText("!", 10).set("addToHistory", false))
    state.command(undo)
    ist(state.doc, doc(p("oops!")), eq)
  })

  function unsyncedComplex(state, doCompress) {
    state.type("hello")
    state.apply(closeHistory(state))
    state.type("!")
    state.apply(state.tr.insertText("....", 1).set("addToHistory", false))
    state.apply(state.tr.split(3))
    ist(state.doc, doc(p(".."), p("..hello!")), eq)
    state.apply(state.tr.split(2).set("addToHistory", false))
    if (doCompress) compress(state)
    state.command(undo)
    state.command(undo)
    ist(state.doc, doc(p("."), p("...hello")), eq)
    state.command(undo)
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
    state.type("hello")
    state.apply(closeHistory(state))
    state.apply(state.tr.delete(1, 6))
    ist(state.doc, doc(p()), eq)
    state.command(undo)
    ist(state.doc, doc(p("hello")), eq)
    state.command(undo)
    ist(state.doc, doc(p()), eq)
  })

  it("supports overlapping edits that aren't collapsed", () => {
    let state = mkState()
    state.apply(state.tr.insertText("h", 1).set("addToHistory", false))
    state.type("ello")
    state.apply(closeHistory(state))
    state.apply(state.tr.delete(1, 6))
    ist(state.doc, doc(p()), eq)
    state.command(undo)
    ist(state.doc, doc(p("hello")), eq)
    state.command(undo)
    ist(state.doc, doc(p("h")), eq)
  })

  it("supports overlapping unsynced deletes", () => {
    let state = mkState()
    state.type("hi")
    state.apply(closeHistory(state))
    state.type("hello")
    state.apply(state.tr.delete(1, 8).set("addToHistory", false))
    ist(state.doc, doc(p()), eq)
    state.command(undo)
    ist(state.doc, doc(p()), eq)
  })

  it("can go back and forth through history multiple times", () => {
    let state = mkState()
    state.type("one")
    state.type(" two")
    state.apply(closeHistory(state))
    state.type(" three")
    state.apply(state.tr.insertText("zero ", 1))
    state.apply(closeHistory(state))
    state.apply(state.tr.split(1))
    state.textSel(1)
    state.type("top")
    for (let i = 0; i < 6; i++) {
      let re = i % 2
      for (let j = 0; j < 4; j++) state.command(re ? redo : undo)
      ist(state.doc, re ? doc(p("top"), p("zero one two three")) : doc(p()), eq)
    }
  })

  it("supports non-tracked changes next to tracked changes", () => {
    let state = mkState()
    state.type("o")
    state.apply(state.tr.split(1))
    state.apply(state.tr.insertText("zzz", 4).set("addToHistory", false))
    state.command(undo)
    ist(state.doc, doc(p("zzz")), eq)
  })

  it("can go back and forth through history when preserving items", () => {
    let state = mkState()
    state.type("one")
    state.type(" two")
    state.apply(closeHistory(state))
    state.apply(state.tr.insertText("xxx", state.selection.head).set("addToHistory", false))
    state.type(" three")
    state.apply(state.tr.insertText("zero ", 1))
    state.apply(closeHistory(state))
    state.apply(state.tr.split(1))
    state.textSel(1)
    state.type("top")
    state.apply(state.tr.insertText("yyy", 1).set("addToHistory", false))
    for (let i = 0; i < 3; i++) {
      if (i == 2) compress(state)
      for (let j = 0; j < 4; j++) state.command(undo)
      ist(state.doc, doc(p("yyyxxx")), eq)
      for (let j = 0; j < 4; j++) state.command(redo)
      ist(state.doc, doc(p("yyytop"), p("zero one twoxxx three")), eq)
    }
  })

  it("restores selection on undo", () => {
    let state = mkState()
    state.type("hi")
    state.apply(closeHistory(state))
    state.textSel(1, 3)
    let selection = state.selection
    state.apply(state.tr.replaceWith(selection.from, selection.to, schema.text("hello")))
    let selection2 = state.selection
    state.command(undo)
    ist(state.selection.eq(selection))
    state.command(redo)
    ist(state.selection.eq(selection2))
  })

  it("rebases selection on undo", () => {
    let state = mkState()
    state.type("hi")
    state.apply(closeHistory(state))
    state.textSel(1, 3)
    state.apply(state.tr.insert(1, schema.text("hello")))
    state.apply(state.tr.insert(1, schema.text("---")).set("addToHistory", false))
    state.command(undo)
    ist(state.selection.head, 6)
  })

  it("handles change overwriting in item-preserving mode", () => {
    let state = mkState(null, {preserveItems: true})
    state.type("a")
    state.type("b")
    state.apply(closeHistory(state))
    state.textSel(1, 3)
    state.type("c")
    state.command(undo)
    state.command(undo)
    ist(state.doc, doc(p()), eq)
  })
})
