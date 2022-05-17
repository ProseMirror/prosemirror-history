import {eq, schema, doc, p} from "prosemirror-test-builder"
import {Slice, Fragment, Node} from "prosemirror-model"
import {EditorState, Plugin, TextSelection, Command} from "prosemirror-state"
import {ReplaceStep} from "prosemirror-transform"
import ist from "ist"
import {history, closeHistory, undo, redo, undoDepth, redoDepth} from "prosemirror-history"

let plugin = history()

function mkState(doc?: Node, config?: any) {
  let plugins = [config ? history(config) : plugin]
  if (config && config.preserveItems) plugins.push(new Plugin({historyPreserveItems: true} as any))
  return EditorState.create({schema, plugins: plugins.concat(config && config.plugins || []), doc})
}

function type(state: EditorState, text: string) {
  return state.apply(state.tr.insertText(text))
}
function command(state: EditorState, command: Command) {
  command(state, tr => state = state.apply(tr))
  return state
}

function compress(state: EditorState) {
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
    let state = mkState(undefined, {newGroupDelay: 1000})
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

  function unsyncedComplex(state: EditorState, doCompress: boolean) {
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
    let state = mkState(undefined, {preserveItems: true})
    state = type(state, "a")
    state = type(state, "b")
    state = state.apply(closeHistory(state.tr))
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)))
    state = type(state, "c")
    state = command(state, undo)
    state = command(state, undo)
    ist(state.doc, doc(p()), eq)
  })

  it("supports querying for the undo and redo depth", () => {
    let state = mkState()
    state = type(state, "a")
    ist(undoDepth(state), 1)
    ist(redoDepth(state), 0)
    state = state.apply(state.tr.insertText("b", 1).setMeta("addToHistory", false))
    ist(undoDepth(state), 1)
    ist(redoDepth(state), 0)
    state = command(state, undo)
    ist(undoDepth(state), 0)
    ist(redoDepth(state), 1)
    state = command(state, redo)
    ist(undoDepth(state), 1)
    ist(redoDepth(state), 0)
  })

  it("all functions gracefully handle EditorStates without history", () => {
    let state = EditorState.create({schema})
    ist(undoDepth(state), 0)
    ist(redoDepth(state), 0)
    ist(undo(state), false)
    ist(redo(state), false)
  })

  it("truncates history", () => {
    let state = mkState(undefined, {depth: 2})
    for (let i = 1; i < 40; ++i) {
      state = type(state, "a")
      state = state.apply(closeHistory(state.tr))
      ist(undoDepth(state), (i - 2) % 21 + 2)
    }
  })

  it("supports transactions with multiple steps", () => {
    let state = mkState()
    state = state.apply(state.tr.insertText("a").insertText("b"))
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

  it("combines appended transactions in the event started by the base transaction", () => {
    let state = mkState(doc(p("x")), {plugins: [new Plugin({
      appendTransaction: (_trs, _old, state) => {
        if (state.doc.content.size == 4) return state.tr.insert(1, schema.text("A"))
      }
    })]})
    state = state.apply(state.tr.insert(2, schema.text("I")))
    ist(state.doc, doc(p("AxI")), eq)
    ist(undoDepth(state), 1)
    state = command(state, undo)
    ist(state.doc, doc(p("x")), eq)
  })

  it("includes transactions appended to undo in the redo history", () => {
    let state = mkState(doc(p("x")), {plugins: [new Plugin({
      appendTransaction: (trs, _old, state) => {
        let add = trs[0].getMeta("add")
        if (add) return state.tr.insert(1, schema.text(add))
      }
    })]})
    state = state.apply(state.tr.insert(2, schema.text("I")).setMeta("add", "A"))
    ist(state.doc, doc(p("AxI")), eq)
    undo(state, tr => state = state.apply(tr.setMeta("add", "B")))
    ist(state.doc, doc(p("Bx")), eq)
    redo(state, tr => state = state.apply(tr.setMeta("add", "C")))
    ist(state.doc, doc(p("CAxI")), eq)
    state = command(state, undo)
    ist(state.doc, doc(p("Bx")), eq)
  })

  it("doesn't close the history on appended transactions", () => {
    let state = mkState(doc(p("x")), {plugins: [new Plugin({
      appendTransaction: (trs, _old, state) => {
        let add = trs[0].getMeta("add")
        if (add) return state.tr.insert(1, schema.text(add))
      }
    })]})
    state = state.apply(state.tr.insert(2, schema.text("R")).setMeta("add", "A"))
    state = state.apply(state.tr.insert(3, schema.text("M")))
    state = command(state, undo)
    ist(state.doc, doc(p("x")), eq)
  })

  it("supports rebasing", () => {
    // This test simulates a collab editing session where the local editor
    // receives a step (`right`) that's on top of the parent step (`base`) of
    // the last local step (`left`).

    // Shared base step
    let state = mkState()
    state = type(state, "base")
    state = state.apply(closeHistory(state.tr))
    const baseDoc = state.doc

    // Local unconfirmed step
    //
    //        - left
    //       /
    // base -
    //       \
    //        - right
    let rightStep = new ReplaceStep(5, 5, new Slice(Fragment.from(schema.text(" right")), 0, 0))
    state = state.apply(state.tr.step(rightStep))
    ist(state.doc, doc(p("base right")), eq)
    ist(undoDepth(state), 2)
    let leftStep = new ReplaceStep(1, 1, new Slice(Fragment.from(schema.text("left ")), 0, 0))

    // Receive remote step and rebase local unconfirmed step
    //
    // base --> left --> right'
    const tr = state.tr
    tr.step(rightStep.invert(baseDoc))
    tr.step(leftStep)
    tr.step(rightStep.map(tr.mapping.slice(1))!)
    tr.mapping.setMirror(0, tr.steps.length - 1)
    tr.setMeta("addToHistory", false)
    tr.setMeta("rebased", 1)
    state = state.apply(tr)
    ist(state.doc, doc(p("left base right")), eq)
    ist(undoDepth(state), 2)

    // Undo local unconfirmed step
    //
    // base --> left
    state = command(state, undo)
    ist(state.doc, doc(p("left base")), eq)

    // Redo local unconfirmed step
    //
    // base --> left --> right'
    state = command(state, redo)
    ist(state.doc, doc(p("left base right")), eq)
  })

  it("properly maps selection when rebasing", () => {
    let state = mkState(doc(p("123456789ABCD")))
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6, 13)))
    state = state.apply(state.tr.delete(6, 13))
    let rebase = state.tr.insert(6, schema.text("6789ABC")).insert(14, schema.text("E")).delete(6, 13)
        .setMeta("rebased", 1).setMeta("addToHistory", false)
    rebase.mapping.setMirror(0, 2)
    state = state.apply(rebase)
    state = command(state, undo)
  })
})
