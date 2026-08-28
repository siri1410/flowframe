import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, test } from '@playwright/test'

/**
 * Renders realistic IBM 3270 / AS400 5250 terminal screens as PNG fixtures.
 * Drawn in the renderer because that is the only place with a font engine.
 */

const SCREENS: Record<string, { rows: string[]; fg: string; bg: string }> = {
  '10-cics-signon': {
    fg: '#33ff66',
    bg: '#000000',
    rows: [
      'CESN                        CICS/ESA SIGNON                       CICSPROD',
      '',
      '                    Type your userid and password, then press ENTER',
      '',
      '',
      '        Userid  . . . . . :  ________',
      '',
      '        Password  . . . . :  ________',
      '',
      '        New Password  . . :  ________',
      '',
      '        Groupid . . . . . :  ________',
      '',
      '        Language  . . . . :  ___',
      '',
      '',
      '',
      '',
      '',
      '',
      'DFHCE3520  Please type your userid.',
      '',
      'F3=Exit    F5=Refresh    F12=Cancel',
      ''
    ]
  },
  '11-customer-inquiry': {
    fg: '#33ff66',
    bg: '#000000',
    rows: [
      'CUST01                   CUSTOMER ACCOUNT INQUIRY              2026-08-25',
      '',
      ' Customer Number . . :  0004821955',
      ' Customer Name . . . :  ACME MANUFACTURING CO',
      ' Account Status  . . :  ACTIVE',
      ' Credit Limit  . . . :      250,000.00',
      ' Balance Due . . . . :       18,442.17',
      '',
      ' Opt  Order No     Order Date   Amount        Status',
      ' ___  0091883      2026-07-14      4,120.00   SHIPPED',
      ' ___  0091914      2026-07-28      8,310.50   INVOICED',
      ' ___  0092007      2026-08-11      6,011.67   OPEN',
      ' ___  0092055      2026-08-19        890.00   OPEN',
      ' ___',
      '',
      ' Opt: 1=Display   2=Change   4=Delete   5=Print',
      '',
      '',
      '',
      '',
      '',
      ' Selection or command',
      ' ===> ______________________________________________________________',
      '',
      'F3=Exit   F5=Refresh   F6=Create   F9=Retrieve   F12=Cancel'
    ]
  },
  '12-order-detail': {
    fg: '#ffb000',
    bg: '#101010',
    rows: [
      'ORD07                      ORDER DETAIL MAINTENANCE               CICSPROD',
      '',
      ' Order Number  . . . :  0092007',
      ' Customer  . . . . . :  0004821955   ACME MANUFACTURING CO',
      '',
      ' Ship To Address . . :  ________________________________',
      ' City  . . . . . . . :  ____________________  State . :  __',
      ' Postal Code . . . . :  _________',
      '',
      ' Requested Date  . . :  __________',
      ' Priority  . . . . . :  _   (1=Rush  2=Normal  3=Low)',
      ' Carrier . . . . . . :  ______',
      '',
      ' Line  Item          Qty      Unit Price     Extended',
      ' 001   BRK-4420       120          18.40      2,208.00',
      ' 002   HSG-1180        45          44.10      1,984.50',
      ' 003   PLT-0092       200           9.09      1,818.00',
      '',
      '                                    Total :   6,011.67',
      '',
      '',
      ' DFH2206  Press ENTER to confirm changes.',
      '',
      'F3=Exit   F10=Confirm   F11=Delete Line   F12=Cancel',
      ''
    ]
  }
}

/** A graphical screen with real words on it, so text capture is exercised there too. */
const APP_SCREEN = {
  width: 760,
  height: 1180,
  draw: `
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, W, 84);
    ctx.fillStyle = '#ffffff'; ctx.font = '600 26px "IBM Plex Sans", sans-serif';
    ctx.fillText('Create your account', 32, 53);

    ctx.fillStyle = '#374151'; ctx.font = '500 19px "IBM Plex Sans", sans-serif';
    ctx.fillText('Full name', 40, 168);
    ctx.fillText('Email address', 40, 300);
    ctx.fillText('Password', 40, 432);
    ctx.fillText('Company', 40, 564);

    ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 2;
    [190, 322, 454, 586].forEach(function (y) { ctx.strokeRect(40, y, W - 80, 58); });

    ctx.fillStyle = '#2563eb'; ctx.fillRect(40, 700, 300, 66);
    ctx.fillStyle = '#ffffff'; ctx.font = '600 22px "IBM Plex Sans", sans-serif';
    ctx.fillText('Create account', 74, 742);

    ctx.strokeStyle = '#9ca3af'; ctx.strokeRect(370, 700, 200, 66);
    ctx.fillStyle = '#374151'; ctx.fillText('Cancel', 428, 742);

    ctx.fillStyle = '#6b7280'; ctx.font = '400 17px "IBM Plex Sans", sans-serif';
    ctx.fillText('By continuing you agree to the terms of service.', 40, 840);

    ctx.fillStyle = '#111827'; ctx.fillRect(0, H - 80, W, 80);
    ctx.fillStyle = '#d1d5db'; ctx.font = '400 16px "IBM Plex Sans", sans-serif';
    ctx.fillText('Privacy    Terms    Support', 40, H - 32);
  `
}

test('render app fixture with real text', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ff-fixture-app-'))
  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, FLOWFRAME_DATA_DIR: dataDir }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 60_000 })

  const base64 = await page.evaluate(async (spec) => {
    await document.fonts.load('20px "IBM Plex Sans"')
    await document.fonts.ready

    const canvas = document.createElement('canvas')
    canvas.width = spec.width
    canvas.height = spec.height
    const ctx = canvas.getContext('2d')!
    const W = spec.width
    const H = spec.height
    // eslint-disable-next-line no-new-func
    new Function('ctx', 'W', 'H', spec.draw)(ctx, W, H)
    return canvas.toDataURL('image/png').split(',')[1]
  }, APP_SCREEN)

  writeFileSync(path.join(__dirname, 'fixtures', '13-app-signup.png'), Buffer.from(base64, 'base64'))
  console.log('wrote 13-app-signup')
  await app.close()
})

test('render terminal fixtures', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ff-fixture-'))
  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, FLOWFRAME_DATA_DIR: dataDir }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 60_000 })

  for (const [name, screen] of Object.entries(SCREENS)) {
    const base64 = await page.evaluate(async (spec) => {
      // Wait for the bundled font before drawing. Without this the fixture is
      // rendered with whatever fallback the platform has, and every glyph metric
      // — including how tall an underscore is — changes between machines.
      await document.fonts.load('18px "IBM Plex Mono"')
      await document.fonts.ready

      // 80x24 character cells, the classic 3270 Model 2 geometry.
      const cols = 80
      const rows = Math.max(24, spec.rows.length)
      const cellW = 12
      const cellH = 24
      const padX = 16
      const padY = 14

      const canvas = document.createElement('canvas')
      canvas.width = cols * cellW + padX * 2
      canvas.height = rows * cellH + padY * 2
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = spec.bg
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      ctx.font = `${Math.round(cellH * 0.72)}px "IBM Plex Mono", monospace`
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = spec.fg

      spec.rows.forEach((line: string, row: number) => {
        for (let col = 0; col < Math.min(line.length, cols); col += 1) {
          const ch = line[col]
          if (ch === ' ') continue
          ctx.fillText(ch, padX + col * cellW, padY + (row + 1) * cellH - cellH * 0.24)
        }
      })

      return canvas.toDataURL('image/png').split(',')[1]
    }, screen)

    writeFileSync(
      path.join(__dirname, 'fixtures', `${name}.png`),
      Buffer.from(base64, 'base64')
    )
    console.log('wrote', name)
  }

  await app.close()
})
