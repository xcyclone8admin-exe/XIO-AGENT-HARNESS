import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startLocalSidecar, type LocalSidecarSession } from '../apps/sidecar/src/runtime.ts';

const root = resolve(fileURLToPath(new URL('../apps/web/out/', import.meta.url)));
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PORT_RESERVATION_FAILED');
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

let staticServer: Server;
let sidecar: LocalSidecarSession;
let origin: string;

test('XIO primary spaces persist chat/theme, preview project changes, and expose the World-linked Library', async ({ page }) => {
  const sidecarCalls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/call/')) sidecarCalls.push(request.url());
  });
  await page.addInitScript(({ port, token }) => {
    window.xyraNative = { getSession: async () => ({ port, token }) };
  }, { port: sidecar.port, token: sidecar.launchToken });

  await page.goto(`${origin}/`);
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'red');
  await expect(page.getByRole('button', { name: 'New conversation' }).first()).toBeEnabled();
  await page.getByRole('button', { name: 'New conversation' }).first().click();
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible();
  const text = `Persisted browser message ${Date.now()}`;
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Save message' }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();

  await page.getByLabel('Theme').selectOption('violet');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'violet');
  await page.reload();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Theme')).toHaveValue('violet');

  await page.getByRole('button', { name: 'World' }).click();
  await expect(page.getByRole('heading', { name: 'A solar system of connected tools' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Solar system graph of registered XYRA modules and declared dependencies' })).toBeVisible();
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectName = `XIO preview project ${Date.now()}`;
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project preview' })).toBeVisible();
  await expect(page.getByText(projectName, { exact: true })).toBeVisible();
  await expect(page.getByText('Persist one project record')).toBeVisible();
  await expect(page.getByText(projectName, { exact: true })).toHaveCount(1);
  expect(sidecarCalls.some((url) => url.includes('forge.projects.create'))).toBeFalsy();
  await page.getByRole('button', { name: 'Approve and create' }).click();
  await expect(page.locator('h2').filter({ hasText: projectName })).toBeVisible();
  expect(sidecarCalls.some((url) => url.includes('forge.projects.create'))).toBeTruthy();

  await page.getByRole('button', { name: 'World' }).click();
  await page.getByRole('button', { name: 'Open the Library' }).click();
  await expect(page.getByRole('heading', { name: 'Knowledge, sources and how XIO works' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'XIO and the XYRA process' })).toBeVisible();

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.filter((violation) => violation.impact === 'critical')).toEqual([]);
});

test.beforeAll(async () => {
  staticServer = createServer((request, response) => {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname); }
    catch { response.writeHead(400).end(); return; }
    const candidate = resolve(root, `.${pathname}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
    const file = existsSync(candidate) && statSync(candidate).isDirectory() ? resolve(candidate, 'index.html') : candidate;
    if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolveListen, reject) => {
    staticServer.once('error', reject);
    staticServer.listen(0, '127.0.0.1', resolveListen);
  });
  const address = staticServer.address();
  if (!address || typeof address === 'string') throw new Error('STATIC_SERVER_START_FAILED');
  origin = `http://127.0.0.1:${address.port}`;
  sidecar = await startLocalSidecar({
    dataDir: 'memory://',
    port: await reservePort(),
    osSubject: `playwright:${Date.now()}`,
    displayName: 'Browser workflow test',
    allowedOrigins: [origin],
  });
});

test.afterAll(async () => {
  if (sidecar) await sidecar.close();
  if (staticServer) await new Promise<void>((resolveClose, reject) => staticServer.close((error) => error ? reject(error) : resolveClose()));
});

test('Forge browser journey creates and edits real workspace records and has no critical accessibility violations', async ({ page }) => {
  await page.addInitScript(({ port, token }) => {
    window.xyraNative = { getSession: async () => ({ port, token }) };
  }, { port: sidecar.port, token: sidecar.launchToken });
  const sidecarCalls: string[] = [];
  const sidecarResponses: Array<{ url: string; status: number; body: string }> = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/call/')) sidecarCalls.push(request.url());
  });
  page.on('response', async (response) => {
    if (!response.url().includes('/api/v1/call/')) return;
    sidecarResponses.push({ url: response.url(), status: response.status(), body: await response.text().catch(() => '') });
  });

  await page.goto(`${origin}/forge/`);
  await expect(page.getByRole('heading', { name: 'Forge' })).toBeVisible();
  await expect(page.getByLabel('New project name')).toBeVisible();

  const projectName = `Browser workflow ${Date.now()}`;
  await page.getByLabel('New project name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue(projectName);

  const epicTitle = `Browser epic ${Date.now()}`;
  await page.getByLabel('New hierarchy title').fill(epicTitle);
  await page.getByRole('button', { name: 'Create epic' }).click();
  await expect.poll(() => sidecarResponses.some(({ url }) => url.includes('forge.nodes.create'))).toBeTruthy();
  const createResponse = sidecarResponses.find(({ url }) => url.includes('forge.nodes.create'));
  expect(createResponse?.status, createResponse?.body).toBe(200);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText(epicTitle, { exact: true })).toBeVisible();

  const update = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const violations = (await update).violations;
  expect(violations.filter((violation) => violation.impact === 'critical')).toEqual([]);
  expect(sidecarCalls.some((url) => url.includes('forge.projects.create'))).toBeTruthy();
  expect(sidecarCalls.some((url) => url.includes('forge.nodes.create'))).toBeTruthy();
});
