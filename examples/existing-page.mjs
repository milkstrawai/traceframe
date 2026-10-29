import { chromium } from 'playwright'
import { recordPage } from '@milkstraw/traceframe'

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(new URL('./recipes.html', import.meta.url).href)
  await page.getByRole('heading', { name: 'Conversation demo' }).waitFor()
  await page.evaluate(() => document.fonts.ready)

  // These locators belong to the caller's existing script.
  const message = page.getByRole('textbox', { name: 'Message' })
  const replies = page.getByRole('list', { name: 'Replies' }).getByRole('listitem')
  const summary = await recordPage({
    page,
    output: process.argv[2] ?? '.traceframe/existing-page.mp4',
    flow: async ({ click, wait, signal }) => {
      await click(message)
      await message.pressSequentially('Record this existing page.', { delay: 45, signal })
      await click(page.getByRole('button', { name: 'Send', exact: true }))
      await replies.first().waitFor({ signal })
      await wait(3)
    },
  })
  // The page is still usable after recording.
  await page.getByRole('status').filter({ hasText: 'Reply complete.' }).waitFor()
  console.log(JSON.stringify(summary))
} finally {
  await browser.close()
}
