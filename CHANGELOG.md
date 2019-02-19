## 1.0.4 (2019-02-19)

### Bug fixes

Fix a bug that corrupted selection data in the history when applying remote steps in some cases.

## 1.0.3 (2018-10-08)

### Bug fixes

Appending a transaction to an undo transaction will no longer immediately clear the redo history.

When handling appended transactions, the history will keep the last step in the original transaction, not the one from the appended transaction, for testing whether a subsequent transaction is adjacent to the previous one.

## 1.0.2 (2018-03-13)

### Bug fixes

Fix a bug that could corrupt the history when rebasing changes because of collaborative editing.

## 1.0.1 (2018-03-05)

### Bug fixes

Fix crash that could occur (in specific circumstance) when redoing.

## 0.24.0 (2017-09-25)

### New features

It is no longer necessary to manually enable the `preserveItems` option to the history plugin when using collaborative editing. (This behavior is now automatically enabled when necessary.)

## 0.20.0 (2017-04-03)

### Bug fixes

Appended transactions no longer generate undo history events.

## 0.19.0 (2017-03-16)

### New features

A new function [`closeHistory`](http://prosemirror.net/docs/ref/version/0.19.0.html#history.closeHistory) can be used to force separation of history events at the start of a given transaction.

## 0.18.0 (2017-02-24)

### Bug fixes

Fix a problem where simultaneous collaborative editing could break the undo history.

## 0.17.1 (2017-02-02)

### Bug fixes

Fix issue where collaborative editing corner cases could corrupt the history.

## 0.12.1 (2016-11-01)

### Bug fixes

Fix crash in undo or redo commands when the history is empty.

## 0.12.0 (2016-10-21)

### Breaking changes

The [`history`](http://prosemirror.net/docs/ref/version/0.12.0.html#history.history) export is now a function
that creates a history plugin, rather than a plugin instance.

### New features

Add a
[`newGroupDelay`](http://prosemirror.net/docs/ref/version/0.12.0.html#history.history^config.newGroupDelay) plugin
option. This brings back the behavior where pausing between edits will
automatically cause the history to put subsequent changes in a new
undo event.

## 0.11.0 (2016-09-21)

### Breaking changes

Moved into a separate module. Now acts as a plugin that can be omitted
or replaced by a different implementation if desired.

Merging subsequent changes into a single undo 'event' is now done by
proximity in the document (the changes must touch) rather than in
time. This will probably have to be further refined.

