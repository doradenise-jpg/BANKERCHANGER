const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const openapiPath = path.resolve(__dirname, '../openapi.yaml');
const spec = YAML.parse(fs.readFileSync(openapiPath, 'utf8'));

const baseUrl = (spec.servers && spec.servers[0] && spec.servers[0].url) || 'http://localhost:3001';

const collections = [];

for (const [p, pathItem] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(pathItem)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

    const tag = (op.tags && op.tags[0]) || 'Default';
    const name = op.summary || `${method.toUpperCase()} ${p}`;

    const headers = [];
    const security = op.security || [];
    if (security.length > 0 && security.some(s => s.bearerAuth)) {
      headers.push({
        key: 'Authorization',
        value: 'Bearer {{auth_token}}',
        type: 'text',
      });
    }

    const query = [];
    const pathParams = [];
    if (op.parameters) {
      for (const param of op.parameters) {
        if (param.in === 'query' && param.schema && param.schema.type && param.schema.type !== 'string') {
          query.push({
            key: param.name,
            value: param.example !== undefined ? String(param.example) : (param.schema.default !== undefined ? String(param.schema.default) : ''),
            type: param.schema.type === 'boolean' ? 'boolean' : 'text',
            disabled: false,
          });
        } else if (param.in === 'query') {
          query.push({
            key: param.name,
            value: '',
            type: 'text',
            disabled: !param.required,
          });
        } else if (param.in === 'path') {
          pathParams.push({ key: param.name, value: '', description: param.description || '' });
        }
      }
    }

    let body = undefined;
    if (op.requestBody) {
      const content = op.requestBody.content || {};
      const jsonContent = content['application/json'];
      if (jsonContent && jsonContent.schema) {
        const example = jsonContent.schema.example;
        body = {
          mode: 'raw',
          raw: example !== undefined ? JSON.stringify(example, null, 2) : '{}',
          options: { raw: { language: 'json' } },
        };
      }
    }

    const segments = [];
    for (const seg of p.split('/').filter(Boolean)) {
      if (/^\{.*\}$/.test(seg)) {
        segments.push(':' + seg.slice(1, -1));
      } else {
        segments.push(seg);
      }
    }
    const url = {
      raw: baseUrl + p,
      host: [baseUrl.replace(/https?:\/\//, '')],
      path: segments,
    };

    const req = {
      name,
      request: {
        method: method.toUpperCase(),
        header: headers,
        url,
      },
      response: [],
    };

    if (query.length) {
      if (!req.request.url.query) req.request.url.query = [];
      req.request.url.query = query;
    }
    if (pathParams.length) {
      if (!req.request.url.variable) req.request.url.variable = [];
      req.request.url.variable = pathParams.map(v => ({ key: v.key, value: '' }));
    }
    if (body) {
      req.request.body = body;
    }

    let group = collections.find(c => c.name === tag);
    if (!group) {
      group = { name: tag, item: [], isCollection: false };
      collections.push(group);
    }
    group.item.push(req);
  }
}

const collection = {
  info: {
    _postman_id: 'bankerchanger-api-' + Date.now(),
    name: 'BANKERCHANGER API',
    description: 'REST API collection for the BANKERCHANGER decentralized boxing prediction market. Import into Postman and set the {{baseUrl}} and {{auth_token}} variables.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: baseUrl },
    { key: 'auth_token', value: '' },
  ],
  auth: {
    type: 'bearer',
    bearer: [{ key: 'token', value: '{{auth_token}}', type: 'string' }],
  },
  item: collections,
};

const outDir = path.resolve(__dirname, '../postman');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'BANKERCHANGER.postman_collection.json');
fs.writeFileSync(outFile, JSON.stringify(collection, null, 2));
console.log('Written', Object.keys(collection).length > 0 ? 'collection' : '', 'to', outFile);
console.log('Groups:', collections.map(c => `${c.name}(${c.item.length})`).join(', '));
