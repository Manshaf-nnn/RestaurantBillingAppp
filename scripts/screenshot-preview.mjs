import { chromium } from 'playwright'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'

async function run(){
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 420, height: 926 } })
  const file = path.resolve(process.cwd(), 'preview-tableflow.html')
  await page.goto(pathToFileURL(file).href)
  await page.screenshot({ path: 'preview-desktop.png', fullPage: false })

  // mobile screenshot (narrow)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.reload()
  await page.screenshot({ path: 'preview-mobile.png', fullPage: false })

  await browser.close()
  console.log('Screenshots written: preview-desktop.png, preview-mobile.png')
}

run().catch((e)=>{console.error(e); process.exit(1)})
