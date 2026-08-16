// Test stub for the `server-only` package. The real module throws when imported
// outside a React Server Component build; under vitest we replace it with a
// no-op so server-side modules that begin with `import 'server-only'` can be
// unit-tested in isolation.
export {}
