import fs from 'fs';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import { parse as parseYaml } from 'yaml';
import type { Express } from 'express';

function resolveOpenApiPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'openapi.yaml');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(__dirname, 'openapi.yaml');
}

const OPENAPI_PATH = resolveOpenApiPath();

function loadOpenApiSpec(): Record<string, unknown> {
  const raw = fs.readFileSync(OPENAPI_PATH, 'utf8');
  return parseYaml(raw) as Record<string, unknown>;
}

export function setupSwagger(app: Express): void {
  const swaggerSpec = loadOpenApiSpec();

  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
    },
  }));

  app.get('/api/docs/openapi.json', (_req, res) => {
    res.json(swaggerSpec);
  });

  app.get('/api/docs/openapi.yaml', (_req, res) => {
    res.type('text/yaml');
    res.send(fs.readFileSync(OPENAPI_PATH, 'utf8'));
  });
}
