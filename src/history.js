const RopeSequence = require("rope-sequence")
const {Mapping} = require("prosemirror-transform")
const {Selection, Plugin, PluginKey} = require("prosemirror-state")

// ProseMirror's history isn't simply a way to roll back to a previous
// state, because ProseMirror supports applying changes without adding
// them to the history (for example during collaboration).
//
// To this end, each 'Branch' (one for the undo history and one for
// the redo history) keeps an array of 'Items', which can optionally
// hold a step (an actual undoable change), and always hold a position
// map (which is needed to move changes below them to apply to the
// current document).
//
// An item that has both a step and a selection JSON representation is
// the start of an 'event' — a group of changes that will be undone
// or redone at once. (It stores only the JSON, since that way we don't
// have to provide a document until the selection is actually applied,
// which is useful when compressing.)

// Used to schedule history compression
const max_empty_items = 500

class Branch {
  constructor(items, eventCount) {
    this.items = items
    this.eventCount = eventCount
  }

  // : (Node, bool, ?Item) → ?{transform: Transform, selection: Object}
  // Pop the latest event off the branch's history and apply it
  // to a document transform.
  popEvent(state, preserveItems) {
    if (this.eventCount == 0) return null

    let end = this.items.length
    for (;; end--) {
      let next = this.items.get(end - 1)
      if (next.selection) { --end; break }
    }

    let remap, mapFrom
    if (preserveItems) {
      remap = this.remapping(end, this.items.length)
      mapFrom = remap.maps.length
    }
    let transform = state.tr
    let selection, remaining
    let addAfter = [], addBefore = []

    this.items.forEach((item, i) => {
      if (!item.step) {
        if (!remap) {
          remap = this.remapping(end, i + 1)
          mapFrom = remap.maps.length
        }
        mapFrom--
        addBefore.push(item)
        return
      }

      if (remap) {
        addBefore.push(new Item(item.map))
        let step = item.step.map(remap.slice(mapFrom)), map

        if (step && transform.maybeStep(step).doc) {
          map = transform.mapping.maps[transform.mapping.maps.length - 1]
          addAfter.push(new Item(map, null, null, addAfter.length + addBefore.length))
        }
        mapFrom--
        if (map) remap.appendMap(map, mapFrom)
      } else {
        transform.maybeStep(item.step)
      }

      if (item.selection) {
        selection = remap ? Selection.mapJSON(item.selection, remap.slice(mapFrom)) : item.selection
        remaining = new Branch(this.items.slice(0, end).append(addBefore.reverse().concat(addAfter)), this.eventCount - 1)
        return false
      }
    }, this.items.length, 0)

    return {remaining, transform, selection}
  }

  // : (Transform, Selection, Object)
  // Create a new branch with the given transform added.
  addTransform(transform, selection, histOptions) {
    let newItems = [], eventCount = this.eventCount + (selection ? 1 : 0)
    let oldItems = this.items, lastItem = !histOptions.preserveItems && oldItems.length ? oldItems.get(oldItems.length - 1) : null

    for (let i = 0; i < transform.steps.length; i++) {
      let step = transform.steps[i].invert(transform.docs[i])
      let item = new Item(transform.mapping.maps[i], step, selection), merged
      if (merged = lastItem && lastItem.merge(item)) {
        item = merged
        if (i) newItems.pop()
        else oldItems = oldItems.slice(0, oldItems.length - 1)
      }
      newItems.push(item)
      selection = null
      if (!histOptions.preserveItems) lastItem = item
    }
    let overflow = this.eventCount - histOptions.depth
    if (overflow > DEPTH_OVERFLOW) oldItems = cutOffEvents(oldItems, overflow)
    return new Branch(oldItems.append(newItems), eventCount)
  }

  remapping(from, to) {
    let maps = [], mirrors = []
    this.items.forEach((item, i) => {
      if (item.mirrorOffset != null) {
        let mirrorPos = i - item.mirrorOffset
        if (mirrorPos >= from) mirrors.push(maps.length - item.mirrorOffset, maps.length)
      }
      maps.push(item.map)
    }, from, to)
    return new Mapping(maps, mirrors)
  }

  addMaps(array) {
    if (this.eventCount == 0) return this
    return new Branch(this.items.append(array.map(map => new Item(map))), this.eventCount)
  }

  // : ([StepMap], Transform, [number])
  // When the collab module receives remote changes, the history has
  // to know about those, so that it can adjust the steps that were
  // rebased on top of the remote changes, and include the position
  // maps for the remote changes in its array of items.
  rebased(rebasedTransform, rebasedCount) {
    if (!this.eventCount) return this

    let rebasedItems = [], start = this.items.length - rebasedCount, startPos = 0
    if (start < 0) {
      startPos = -start
      start = 0
    }

    let mapping = rebasedTransform.mapping
    let newUntil = rebasedTransform.steps.length

    let iRebased = startPos
    this.items.forEach(item => {
      let pos = mapping.getMirror(iRebased++)
      if (pos == null) return
      newUntil = Math.min(newUntil, pos)
      let map = mapping.maps[pos]
      if (item.step) {
        let step = rebasedTransform.steps[pos].invert(rebasedTransform.docs[pos])
        let selection = item.selection && Selection.mapJSON(item.selection, mapping.slice(iRebased - 1, pos))
        rebasedItems.push(new Item(map, step, selection))
      } else {
        rebasedItems.push(new Item(map))
      }
    }, start)

    let newMaps = []
    for (let i = rebasedCount; i < newUntil; i++)
      newMaps.push(new Item(mapping.maps[i]))
    let items = this.items.slice(0, start).append(newMaps).append(rebasedItems)
    let branch = new Branch(items, this.eventCount) // FIXME might update event count
    if (branch.emptyItemCount() > max_empty_items)
      branch = branch.compress(this.items.length - rebasedItems.length)
    return branch
  }

  emptyItemCount() {
    let count = 0
    this.items.forEach(item => { if (!item.step) count++ })
    return count
  }

  // Compressing a branch means rewriting it to push the air (map-only
  // items) out. During collaboration, these naturally accumulate
  // because each remote change adds one. The `upto` argument is used
  // to ensure that only the items below a given level are compressed,
  // because `rebased` relies on a clean, untouched set of items in
  // order to associate old items with rebased steps.
  compress(upto = this.items.length) {
    let remap = this.remapping(0, upto), mapFrom = remap.maps.length
    let items = [], events = 0
    this.items.forEach((item, i) => {
      if (i >= upto) {
        items.push(item)
      } else if (item.step) {
        let step = item.step.map(remap.slice(mapFrom)), map = step && step.getMap()
        mapFrom--
        if (map) remap.appendMap(map, mapFrom)
        if (step) {
          let selection = item.selection && Selection.mapJSON(item.selection, remap.slice(mapFrom))
          if (selection) events++
          let newItem = new Item(map.invert(), step, selection), merged, last = items.length - 1
          if (merged = items.length && items[last].merge(newItem))
            items[last] = merged
          else
            items.push(newItem)
        }
      } else if (item.map) {
        mapFrom--
      }
    }, this.items.length, 0)
    return new Branch(RopeSequence.from(items.reverse()), events)
  }
}

Branch.empty = new Branch(RopeSequence.empty, 0)

function cutOffEvents(items, n) {
  let cutPoint
  items.forEach((item, i) => {
    if (item.selection && (--n == 0)) {
      cutPoint = i
      return false
    }
  })
  return items.slice(cutPoint)
}

class Item {
  constructor(map, step, selection, mirrorOffset) {
    this.map = map
    this.step = step
    this.selection = selection
    this.mirrorOffset = mirrorOffset
  }

  merge(other) {
    if (this.step && other.step && !other.selection) {
      let step = other.step.merge(this.step)
      if (step) return new Item(step.getMap().invert(), step, this.selection)
    }
  }
}

// The value of the state field that tracks undo/redo history for that
// state. Will be stored in the plugin state when the history plugin
// is active.
class HistoryState {
  constructor(done, undone, prevMap, prevTime) {
    this.done = done
    this.undone = undone
    this.prevMap = prevMap
    this.prevTime = prevTime
  }
}
exports.HistoryState = HistoryState

const DEPTH_OVERFLOW = 20

// : (EditorState, Transform, Selection, Object)
// Record a transformation in undo history.
function recordTransform(history, selection, action, options) {
  let transform = action.transform
  if (action.historyState) {
    return action.historyState
  } else if (transform.steps.length == 0) {
    return history
  } else if (action.addToHistory !== false) {
    // Group transforms that occur in quick succession into one event.
    let newGroup = history.prevTime < (action.time || 0) - options.newGroupDelay ||
        !isAdjacentToLastStep(transform, history.prevMap, history.done)
    return new HistoryState(history.done.addTransform(transform, newGroup ? selection.toJSON() : null, options),
                            Branch.empty, transform.mapping.maps[transform.steps.length - 1], action.time)
  } else if (action.rebased) {
    // Used by the collab module to tell the history that some of its
    // content has been rebased.
    return new HistoryState(history.done.rebased(transform, action.rebased),
                            history.undone.rebased(transform, action.rebased),
                            history.prevMap && transform.mapping.maps[transform.steps.length - 1], history.prevTime)
  } else {
    return new HistoryState(history.done.addMaps(transform.mapping.maps),
                            history.undone.addMaps(transform.mapping.maps),
                            history.prevMap, history.prevTime)
  }
}

function isAdjacentToLastStep(transform, prevMap, done) {
  if (!prevMap) return false
  let firstMap = transform.mapping.maps[0], adjacent = false
  if (!firstMap) return true
  firstMap.forEach((start, end) => {
    done.items.forEach(item => {
      if (item.step) {
        prevMap.forEach((_start, _end, rStart, rEnd) => {
          if (start <= rEnd && end >= rStart) adjacent = true
        })
        return false
      } else {
        start = item.map.invert().map(start, -1)
        end = item.map.invert().map(end, 1)
      }
    }, done.items.length, 0)
  })
  return adjacent
}

// : (EditorState, bool, Object) → Object
// Apply the latest event from one branch to the document and optionally
// shift the event onto the other branch. Returns true when an event could
// be shifted.
function histAction(history, state, onAction, redo) {
  let histOptions = historyKey.get(state).options.config
  let pop = (redo ? history.undone : history.done).popEvent(state, histOptions.preserveItems)
  if (!pop) return

  let selectionBefore = state.selection
  let selection = Selection.fromJSON(pop.transform.doc, pop.selection)
  let added = (redo ? history.done : history.undone).addTransform(pop.transform, selectionBefore.toJSON(), histOptions)

  let newHist = new HistoryState(redo ? added : pop.remaining, redo ? pop.remaining : added, null, 0)
  onAction(pop.transform.action({selection, historyState: newHist, scrollIntoView: true, sealed: true}))
}

const historyKey = new PluginKey("history")

// :: (?Object) → Plugin
// Returns a plugin that enables the undo history for an editor.
//
//   config::-
//   Supports the following configuration options:
//
//     depth:: ?number
//     The amount of history events that are collected before the
//     oldest events are discarded. Defaults to 100.
//
//     newGroupDelay:: number
//     The delay between changes after which a new group should be
//     started. Defaults to 500 (milliseconds). Note that when changes
//     aren't adjacent, a new group is always started.
//
//     preserveItems:: ?bool
//     Whether to preserve the steps exactly as they came in. **Must**
//     be true when using the history together with the collaborative
//     editing plugin, to allow syncing the history when concurrent
//     changes come in. Defaults to false.
function history(config) {
  config = {depth: config && config.depth || 100,
            preserveItems: !!(config && config.preserveItems),
            newGroupDelay: config && config.newGroupDelay || 500}
  return new Plugin({
    key: historyKey,

    state: {
      init() {
        return new HistoryState(Branch.empty, Branch.empty, null, 0)
      },
      applyAction(action, hist, state) {
        if (action.type == "transform")
          return recordTransform(hist, state.selection, action, config)
        if (action.type == "historyClose")
          return new HistoryState(hist.done, hist.undone, null, 0)
        return hist
      }
    },

    config
  })
}
exports.history = history

// :: (state: EditorState, onAction: ?(action: Action)) → bool
// A command function that undoes the last change, if any.
function undo(state, onAction) {
  let hist = historyKey.getState(state)
  if (!hist || hist.done.eventCount == 0) return false
  if (onAction) histAction(hist, state, onAction, false)
  return true
}
exports.undo = undo

// :: (state: EditorState, onAction: ?(action: Action)) → bool
// A command function that redoes the last undone change, if any.
function redo(state, onAction) {
  let hist = historyKey.getState(state)
  if (!hist || hist.undone.eventCount == 0) return false
  if (onAction) histAction(hist, state, onAction, true)
  return true
}
exports.redo = redo

// :: (EditorState) → number
// The amount of undoable events available in a given state.
function undoDepth(state) {
  let hist = historyKey.getState(state)
  return hist ? hist.done.eventCount : 0
}
exports.undoDepth = undoDepth

// :: (EditorState) → number
// The amount of redoable events available in a given editor state.
function redoDepth(state) {
  let hist = historyKey.getState(state)
  return hist ? hist.undone.eventCount : 0
}
exports.redoDepth = redoDepth
