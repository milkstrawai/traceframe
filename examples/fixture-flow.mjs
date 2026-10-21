export async function ready({ page }) {
  await page.getByRole('heading', { name: 'Example workspace' }).waitFor()
}

export default async function ({ page, hover, click, wait }) {
  const open = page.getByRole('button', { name: 'Open settings' })
  await hover(open, { duration: 1.1 })
  await click(open)
  await wait(0.6)

  await click(page.getByRole('combobox', { name: 'Theme' }), { duration: 0.9 })
  await wait(0.4)

  await click(page.getByRole('option', { name: 'Dark' }), { duration: 0.7 })
  await wait(0.7)

  await click(page.getByRole('button', { name: 'Save', exact: true }), { duration: 0.9 })
  await wait(1.6)

  await click(page.getByRole('button', { name: 'Close settings' }), { duration: 0.9 })
  await wait(1.2)
}
