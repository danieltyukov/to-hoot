// Points every stdout console method at stderr, as a module side effect.
//
// This is a separate module because of how ESM evaluates. Statements at the top
// of an entry point look like they run first, but imports are hoisted and the
// imported modules are evaluated BEFORE any statement in the importing module's
// body. Assigning to `console.log` in `index.ts` after its import list
// therefore runs after the whole SDK has already been evaluated, which is
// exactly the window a dependency that logs on import would use.
//
// Importing this module for its side effect, first in the list, closes that
// window: the module graph is evaluated in import order, so this body runs
// before any later import's body.
//
// stdout is the protocol channel. One line that is not a JSON-RPC message
// breaks the connection, and it looks like the server crashing rather than like
// something logging.

// Node sends .log, .info and .debug to stdout; .error and .warn already go to
// stderr, so they are left alone.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

export {};
