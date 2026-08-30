const path = require('path');
const SwaggerParser = require('@apidevtools/swagger-parser');

const OPENAPI_PATH = path.resolve(__dirname, '../openapi.yaml');

SwaggerParser.validate(OPENAPI_PATH)
  .then((api) => {
    const methods = Object.values(api.paths).reduce((acc, p) => {
      Object.keys(p).forEach((m) => {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) acc++;
      });
      return acc;
    }, 0);
    console.log(`OpenAPI spec is valid: ${Object.keys(api.paths).length} paths, ${methods} operations`);
  })
  .catch((err) => {
    console.error(`OpenAPI spec INVALID: ${err.message}`);
    process.exit(1);
  });
