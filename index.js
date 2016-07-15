const RopeSequence = require("rope-sequence")
const {Transform, Remapping} = require("../transform")

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
// An item that has both a step and a selection token field is the
// start of an 'event' -- a group of changes that will be undone or
// redone at once. (It stores only a token, since that way we don't
// have to provide a document until the selection is actually applied,
// which is useful when compressing.)

// Used to schedule history compression
const max_empty_items = 500

class Branch {
  constructor(items, eventCount) {
    this.items = items
    this.eventCount = eventCount
  }

  // : (Node, bool, ?Item) → ?{transform: Transform, selection: SelectionToken, ids: [number]}
  // Pop the latest event off the branch's history and apply it
  // to a document transform, returning the transform and the step IDs.
  popEvent(doc, preserveItems) {
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
    let transform = new Transform(doc)
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
        selection = remap ? item.selection.type.mapToken(item.selection, remap.slice(mapFrom)) : item.selection
        remaining = new Branch(this.items.slice(0, end).append(addBefore.reverse().concat(addAfter)), this.eventCount - 1)
        return false
      }
    }, this.items.length, 0)

    return {remaining, transform, selection}
  }

  // : (Transform, Selection, ?[number])
  // Create a new branch with the given transform added.
  addTransform(transform, selection) {
    let newItems = [], eventCount = this.eventCount + (selection ? 1 : 0)
    for (let i = 0; i < transform.steps.length; i++) {
      let step = transform.steps[i].invert(transform.docs[i])
      newItems.push(new Item(transform.mapping.maps[i], step, selection))
      selection = null
    }
    return new Branch(this.items.append(newItems), eventCount)
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
    return new Remapping(maps, mirrors)
  }

  addMaps(array) {
    if (this.eventCount == 0) return this
    return new Branch(this.items.append(array.map(map => new Item(map))), this.eventCount)
  }

  // : ([PosMap], Transform, [number])
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
        let selection = item.selection &&
            item.selection.type.mapToken(item.selection, mapping.slice(iRebased - 1, pos))
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
  // order to associate old ids to rebased steps.
  compress(upto) {
    if (upto == null) upto = this.items.length
    let remap = this.remapping(0, upto), mapFrom = remap.maps.length
    let items = [], events = 0
    this.items.forEach((item, i) => {
      if (i >= upto) {
        items.push(item)
      } else if (item.step) {
        let step = item.step.map(remap.slice(mapFrom)), map = step && step.posMap()
        mapFrom--
        if (map) remap.appendMap(map, mapFrom)
        if (step) {
          let selection = item.selection && item.selection.type.mapToken(item.selection, remap.slice(mapFrom))
          items.push(new Item(map.invert(), step, selection))
          if (selection) events++
        }
      } else if (item.map) {
        mapFrom--
      } else {
        items.push(item)
      }
    }, this.items.length, 0)
    return new Branch(RopeSequence.from(items.reverse()), events)
  }
}

Branch.empty = new Branch(RopeSequence.empty, 0)

// History items all have ids, but the meaning of these is somewhat
// complicated.
//
// - For StepItems, the ids are kept ordered (inside a given branch),
//   and are kept associated with a given change (if you undo and then
//   redo it, the resulting item gets the old id)
//
// - For MapItems, the ids are just opaque identifiers, not
//   necessarily ordered.
//
// - The placeholder item at the base of a branch's list
class Item {
  constructor(map, step, selection, mirrorOffset) {
    this.map = map
    this.step = step
    this.selection = selection
    this.mirrorOffset = mirrorOffset
  }
}

// ;; An undo/redo history manager for an editor instance.
class History {
  constructor(options, done, undone, lastAddedAt) {
    this.options = options
    this.done = done
    this.undone = undone
    this.lastAddedAt = lastAddedAt
  }

  // : (Transform, Selection, Object)
  // Record a transformation in undo history.
  applyTransform(transform, options, oldState) {
    if (options.historyIgnore) {
      // Ignore
      return this
    } else if (options.addToHistory == false) {
      if (options.rebased) {
        // Used by the collab module to tell the history that some of its
        // content has been rebased.
        return new History(this.options,
                           this.done.rebased(transform, options.rebased),
                           this.undone.rebased(transform, options.rebased),
                           this.lastAddedAt)
      } else {
        return new History(this.options,
                           this.done.addMaps(transform.mapping.maps),
                           this.undone.addMaps(transform.mapping.maps),
                           this.lastAddedAt)
      }
    } else {
      let now = Date.now()
      // Group transforms that occur in quick succession into one event.
      let newGroup = now > this.lastAddedAt + this.options.eventDelay
      return new History(this.options,
                         this.done.addTransform(transform, newGroup ? oldState.selection.token : null),
                         Branch.empty,
                         now)
    }
  }

  // :: number
  // The amount of undoable events available.
  get undoDepth() { return this.done.eventCount }

  // :: number
  // The amount of redoable events available.
  get redoDepth() { return this.undone.eventCount }

  // :: () → History
  // Makes sure that the next change made will start a new history
  // event, not be added to the last event.
  cut() { return new History(this.options, this.done, this.undone, 0) }

  // : (Branch, Branch) → bool
  // Apply the latest event from one branch to the document and optionally
  // shift the event onto the other branch. Returns true when an event could
  // be shifted.
  shift(state, redo) {
    let pop = (redo ? this.undone : this.done).popEvent(state.doc, this.options.preserveItems)
    if (!pop) return state

    let selectionBeforeTransform = state.selection
    let selection = pop.selection.type.fromToken(pop.selection, pop.transform.doc)
    let added = (redo ? this.done : this.undone).addTransform(pop.transform, selectionBeforeTransform.token)

    let newHist = new History(this.options, redo ? added : pop.remaining, redo ? pop.remaining : added, 0)
    let newState = state.applyTransform(pop.transform, {selection, filter: false, historyIgnore: true})
        .update({history: newHist})
    if (!pop.transform.steps.length && pop.remaining.eventCount) return newHist.shift(newState, redo)
    return newState
  }

  // :: () → state
  // Undo one history event. The return value indicates whether
  // anything was actually undone. Note that in a collaborative
  // context, or when changes are [applied](#ProseMirror.apply)
  // without adding them to the history, it is possible for
  // [`undoDepth`](#History.undoDepth) to have a positive value, but
  // this method to still return `false`, when non-history changes
  // overwrote all remaining changes in the history.
  undo(state) {
    return this.shift(state, false)
  }

  // :: () → bool
  // Redo one history event. The return value indicates whether
  // anything was actually redone.
  redo(state) {
    return this.shift(state, true)
  }
}
exports.History = History

const pluginIdentity = {plugin: "history"}

const defaults = {
  depth: 100,
  eventDelay: 500,
  preserveItems: false
}

// :: (Object) → Plugin
// A plugin that enables the undo history for an editor. Has the
// effect of setting the editor's `history` property to an instance of
// `History`. Takes the following options:
//
// **`depth`**`: number`
//   : The amount of history events that are collected before the
//     oldest events are discarded. Defaults to 100.
//
// **`eventDelay`**`: number`
//   : The amount of milliseconds that must pass between changes to
//     start a new history event. Defaults to 500.
exports.historyPlugin = function(config) {
  let options = {}
  for (let prop in defaults) options[prop] = config && config.hasOwnProperty(prop) ? config[prop] : defaults[prop]

  return {
    config: options,

    identity: pluginIdentity,
    merge(other) {
      return exports.historyPlugin({
        depth: Math.max(this.config.depth, other.config.depth),
        eventDelay: this.config.eventDelay,
        preserveItems: this.config.preserveItems || other.config.preserveItems
      })
    },

    stateFields: {history: new History(options, Branch.empty, Branch.empty, 0)}
  }
}
