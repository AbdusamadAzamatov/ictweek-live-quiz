import { test, expect, type Page } from '@playwright/test';

/**
 * Release checklist against the production build (Fastify serving web/dist +
 * /api on :3100). Serial: each step builds on the previous one's state.
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

let hostPage: Page;
let displayPage: Page;
let anna: Page;
let bobur: Page;
let pin = '';
let displayHref = '';
let annaQ1 = 0;
let annaQ2 = 0;

test.beforeAll(async ({ browser }) => {
  hostPage = await (await browser.newContext()).newPage();
  const mkPlayer = async () =>
    (
      await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      })
    ).newPage();
  anna = await mkPlayer();
  bobur = await mkPlayer();
});

test.afterAll(async () => {
  await hostPage?.context().close();
  await displayPage?.context().close();
  await anna?.context().close();
  await bobur?.context().close();
});

test('1. organizer login', async () => {
  await hostPage.goto('/admin/login');
  await hostPage.getByPlaceholder('Email').fill('e2e@example.com');
  await hostPage.getByPlaceholder('Password').fill('E2ePassword123!');
  await hostPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(hostPage.getByRole('heading', { name: 'Quiz library' })).toBeVisible();
});

test('2. quiz creation', async () => {
  await hostPage.getByRole('button', { name: 'Create quiz' }).click();
  await expect(hostPage).toHaveURL(/\/admin\/quizzes\//);
  await hostPage.getByPlaceholder('Quiz title').fill('E2E Release Quiz');

  await hostPage.getByRole('button', { name: '+ Single choice' }).click();
  await hostPage.getByPlaceholder('Ask something…').fill('E2E Q1');
  // SINGLE starts with 2 options; add C and D.
  await hostPage.getByRole('button', { name: '+ Add option' }).click();
  await hostPage.getByRole('button', { name: '+ Add option' }).click();
  for (const [letter, text] of [
    ['A', 'Alpha'],
    ['B', 'Beta'],
    ['C', 'Gamma'],
    ['D', 'Delta'],
  ] as const) {
    await hostPage.getByPlaceholder(`Option ${letter}`).fill(text);
  }
  // Mark Alpha (first option) correct.
  await hostPage.getByTitle('Mark correct').first().click();

  await hostPage.getByRole('button', { name: '+ True / False' }).click();
  await hostPage.getByPlaceholder('Ask something…').fill('E2E Q2');
  // True is created as correct; click its toggle to mark it deliberately.
  await hostPage.getByTitle('Correct').first().click();

  await expect(hostPage.getByText('Saved', { exact: true })).toBeVisible();
  await expect(hostPage.getByText('Quiz is playable')).toBeVisible();
});

test('3. hosting', async () => {
  await hostPage.getByRole('link', { name: 'Host session' }).click();
  await expect(hostPage).toHaveURL(/\/admin\/sessions\/new/);
  // role=switch sits next to its label text inside the same row.
  await hostPage
    .getByText('Show question text on phones')
    .locator('..')
    .getByRole('switch')
    .click();
  await hostPage.getByRole('button', { name: 'Start session' }).click();
  await expect(hostPage).toHaveURL(/\/admin\/host\//);

  const pinEl = hostPage.getByText(/^\d{6}$/).first();
  await expect(pinEl).toBeVisible();
  pin = ((await pinEl.textContent()) ?? '').trim();
  expect(pin).toMatch(/^\d{6}$/);
  await expect(hostPage.getByRole('heading', { name: 'Players (0)' })).toBeVisible();

  displayHref =
    (await hostPage.getByRole('link', { name: 'Open projector view' }).getAttribute('href')) ??
    '';
  expect(displayHref).toMatch(/^\/display\//);
});

test('4. projector view', async () => {
  displayPage = await hostPage.context().newPage();
  await displayPage.goto(displayHref);
  await expect(displayPage.getByText(pin, { exact: true })).toBeVisible();
  await expect(displayPage.getByText('0 players in the lobby')).toBeVisible();
});

test('5. participants join', async () => {
  for (const [player, nickname] of [
    [anna, 'Anna'],
    [bobur, 'Bobur'],
  ] as const) {
    await player.goto(`/join/${pin}`);
    await player.getByPlaceholder('Nickname').fill(nickname);
    await player.getByRole('button', { name: 'Enter lobby' }).click();
    await expect(player.getByText("You're in!")).toBeVisible();
  }
  await expect(hostPage.getByRole('heading', { name: 'Players (2)' })).toBeVisible();
  await expect(displayPage.getByText('2 players in the lobby')).toBeVisible();
  await expect(displayPage.getByText('Anna')).toBeVisible();
  await expect(displayPage.getByText('Bobur')).toBeVisible();
});

test('6. start + submit answers', async () => {
  await hostPage.getByRole('button', { name: 'Start game' }).click();
  await expect(displayPage.getByRole('heading', { name: 'E2E Q1' })).toBeVisible();

  await anna.getByRole('button', { name: /Alpha/ }).click();
  await expect(anna.getByText('Answer sent')).toBeVisible();
  await expect(anna.getByRole('button', { name: /Alpha/ })).toBeVisible();

  await bobur.getByRole('button', { name: /Beta/ }).click();
  // Bobur's answer auto-closes the question — the reveal may beat the
  // "Answer sent" render, so accept either.
  await expect(bobur.getByText(/Answer sent|Incorrect/)).toBeVisible();
});

test('7. reveal and results', async () => {
  // Both answered → auto-closed → distribution on the display.
  const alphaRow = displayPage.getByText('Alpha', { exact: true }).locator('xpath=../..');
  await expect(alphaRow.getByText('✓')).toBeVisible();
  await expect(alphaRow.getByText(/^1$/)).toBeVisible();
  const betaRow = displayPage.getByText('Beta', { exact: true }).locator('xpath=../..');
  await expect(betaRow.getByText(/^1$/)).toBeVisible();
  await expect(betaRow.getByText('✓')).toHaveCount(0);

  await expect(anna.getByText('Correct!')).toBeVisible();
  const pts = await anna.getByText(/^\+\d+$/).textContent();
  annaQ1 = Number((pts ?? '').replace(/\D/g, ''));
  expect(annaQ1).toBeGreaterThan(0);
  await expect(bobur.getByText('Incorrect')).toBeVisible();
});

test('8. host refresh recovery', async () => {
  await hostPage.reload();
  await expect(hostPage.getByRole('button', { name: 'Next' })).toBeVisible();
  await hostPage.getByRole('button', { name: 'Next' }).click();
  // Leaderboard: Anna at #1.
  const top = displayPage.getByText('#1', { exact: true }).locator('..');
  await expect(top.getByText('Anna')).toBeVisible();
  await hostPage.getByRole('button', { name: 'Next' }).click();
  // Countdown runs (1500 ms) then Q2 opens.
  await expect(displayPage.getByRole('heading', { name: 'E2E Q2' })).toBeVisible();
});

test('9. player refresh recovery', async () => {
  await anna.getByRole('button', { name: /True/ }).click();
  await expect(anna.getByText('Answer sent')).toBeVisible();
  await anna.reload();
  await expect(anna.getByText('Answer sent')).toBeVisible();
  await expect(anna.getByRole('button', { name: /True/ })).toBeVisible();

  await hostPage.getByRole('button', { name: 'Close answers' }).click();
  await expect(anna.getByText('Correct!')).toBeVisible();
  const pts = await anna.getByText(/^\+\d+$/).textContent();
  annaQ2 = Number((pts ?? '').replace(/\D/g, ''));
  expect(annaQ2).toBeGreaterThan(0);
  // Bobur did not answer → reveal shows Incorrect (lastResult correct:false).
  await expect(bobur.getByText('Incorrect')).toBeVisible();
});

test('10. podium + report', async () => {
  // Last question: the advance button reads "Show podium" and the reveal
  // passes through LEADERBOARD before FINISHED.
  const podium = displayPage.getByRole('heading', { name: 'Podium' });
  for (let i = 0; i < 3 && !(await podium.isVisible()); i++) {
    await hostPage
      .getByRole('button', { name: /Next|Show podium/ })
      .first()
      .click();
    await displayPage.waitForTimeout(800);
  }
  await expect(podium).toBeVisible();
  // Rank-1 column (the tallest, middle block) carries Anna's name.
  const rank1Col = displayPage.getByText('1', { exact: true }).locator('xpath=../..');
  await expect(rank1Col.getByText('Anna')).toBeVisible();

  await expect(anna.getByText('Thanks for playing')).toBeVisible();
  await expect(anna.getByText(/Final rank #1/)).toBeVisible();

  await hostPage.getByRole('link', { name: 'Open report' }).click();
  await expect(hostPage).toHaveURL(/\/admin\/sessions\/.*\/report/);
  // Standings table rows start with the rank; per-question rows don't.
  const annaRow = hostPage.getByRole('row', { name: /^1 Anna / });
  await expect(annaRow).toContainText(String(annaQ1 + annaQ2));
  const boburRow = hostPage.getByRole('row', { name: /^2 Bobur / });
  await expect(boburRow).toContainText('0');
  await expect(hostPage.getByRole('link', { name: 'Download CSV' })).toBeVisible();
});
