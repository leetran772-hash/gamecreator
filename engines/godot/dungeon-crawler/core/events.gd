# Tiny event bus, same semantics as src/core/events.ts: handlers run in the
# order they were added, on a copy of the list. Modules talk only through
# events and the shared contracts (item schema), never through internals.
extends RefCounted

var _handlers := {}


## Returns a Callable that removes the handler again.
func on(event: String, handler: Callable) -> Callable:
	if not _handlers.has(event):
		_handlers[event] = []
	_handlers[event].append(handler)
	return func() -> void: _handlers[event].erase(handler)


func emit(event: String, payload: Dictionary) -> void:
	if not _handlers.has(event):
		return
	for h in _handlers[event].duplicate():
		(h as Callable).call(payload)
