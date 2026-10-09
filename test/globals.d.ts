// Recent `@types/node` releases no longer re-export these undici-types helpers as globals.
// Derive them from the platform types that are still global so tests keep precise types
// without pulling the whole DOM library into this Node-only project.

type BodyInit = NonNullable<RequestInit["body"]>;

type ReadableStreamReadResult<T> = Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>;
