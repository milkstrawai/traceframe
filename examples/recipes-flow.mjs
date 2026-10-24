export async function ready({ page }) {
  await page.getByRole('heading', { name: 'Conversation demo' }).waitFor()
}

export default async function ({ page, click, hover, wait }) {
  const message = page.getByRole('textbox', { name: 'Message' })
  const replies = page.getByRole('list', { name: 'Replies' }).getByRole('listitem')
  for (const [index, text] of ['Give me a short summary.', 'هل يمكنك التوضيح؟'].entries()) {
    await click(message)
    await message.pressSequentially(text, { delay: 45 })
    await click(page.getByRole('button', { name: 'Send', exact: true }))
    await replies.nth(index).waitFor({ timeout: 60_000 })
    await wait(0.6)
  }

  const upload = page.getByText('Choose a sample file', { exact: true })
  await hover(upload)
  await page.getByLabel('Choose a sample file').setInputFiles({
    name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('Example file for a local demo.\n'),
  })
  await page.getByText('Selected: sample.txt', { exact: true }).waitFor()
  await wait(0.6)

  await click(page.getByRole('button', { name: 'Finish demo', exact: true }))
  await page.getByRole('button', { name: 'Demo complete', exact: true }).waitFor()
  await wait(0.8)
}
