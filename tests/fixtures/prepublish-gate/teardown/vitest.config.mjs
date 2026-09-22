export default {
  test: {
    include: ['**/*.spec.mjs'],
    globalSetup: ['./teardown-throws.mjs'],
  },
};
