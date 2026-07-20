const path = require('path');
const pkg = require('../packages/core/package.json');

module.exports = {
  dependencies: {
    [pkg.name]: {
      root: path.join(__dirname, '..', 'packages', 'core'),
      platforms: {
        // Codegen script incorrectly fails without this
        // So we explicitly specify the platforms with empty object
        ios: {},
        android: {},
      },
    },
  },
};
