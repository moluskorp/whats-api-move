import puppeteer, {
  TimeoutError,
  Page,
  Browser,
  PuppeteerLaunchOptions,
} from 'puppeteer'
import fs from 'node:fs'
import { ExposeStore, LoadUtils } from '../Util/injected'
import EventEmitter from 'node:events'
import { ChatFactory } from '../factories/ChatFactory'
import { ChatData } from '../types/ChatData'
import { env } from '../env'
import { join } from 'node:path'

interface Initialize {
  headless: 'new' | true | false
}

export class Client extends EventEmitter {
  private _qr = ''
  public get qr() {
    return this._qr
  }

  private set qr(value) {
    this._qr = value
    this.emit('qr', value)
  }

  private _status: 'Authenticate' | 'ready' | 'disconnected' | 'Loading' =
    'Authenticate'

  public get status() {
    return this._status
  }

  private set status(value) {
    this._status = value
    console.log('status alterado para: ', value)
    this.emit(value)
  }

  public loading = false
  public needsQr = true
  private FILEPATH = 'localStorage.json'
  private page: Page
  private browser: Browser

  constructor(browser: Browser, page: Page) {
    super()
    this.page = page
    this.browser = browser
  }

  static async create({ headless }: Initialize) {
    const launchOptions = {
      headless: headless === 'new' ? 'new' : headless,
      defaultViewport: null,
      userDataDir: 'teste1',
      executablePath: env.PUPPETEER_EXECUTABLE_PATH,
    } as PuppeteerLaunchOptions

    const browser = await puppeteer.launch(launchOptions)
    const page = await browser.newPage()

    return new Client(browser, page)
  }

  async initialize() {
    try {
      await this.page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36',
      )
      await this.page.setViewport({ width: 1920, height: 1080 })
      this.page.setBypassCSP(true)
      await this.page.goto('https://web.whatsapp.com/')
      this.page.on('console', (msg) => console.log('PAGE LOG:', msg.text()))
      this.page.on('error', (err) => console.log('PAGE ERROR:', err))
      this.page.on('pageerror', (pageerr) =>
        console.log('PAGE ERROR:', pageerr),
      )

      const element = await this.page.waitForSelector('div > .landing-title', {
        timeout: 8000,
      })

      if (element) {
        console.log('if element 1 qr')
        await this.page.waitForSelector('[data-ref]')
        const a = await this.page.$eval('[data-ref]', (el) =>
          el.getAttribute('data-ref'),
        )
        if (a) {
          this.qr = a
        }
        setTimeout(() => {
          this.refreshQr()
        }, 1000)
      }
    } catch (e) {
      if (e instanceof TimeoutError) {
        console.log('Não achou landing-page')
      }
    }
  }

  private async saveLocalStorage() {
    const localStorageData = await this.page.evaluate(() => {
      const data = {} as any
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key) {
          const value = localStorage.getItem(key)
          data[key] = value
        }
      }
      return data
    })

    fs.writeFileSync(this.FILEPATH, JSON.stringify(localStorageData))
  }

  private async injections() {
    await this.page.waitForFunction('window.ModuleRaid !== undefined')
    await this.page.evaluate(ExposeStore)
    await this.page.evaluate(LoadUtils)
    this.loadChats()
  }

  private async waitForLoadingMessageExit() {
    try {
      console.log('Buscando mensagem de carregamento')
      const loadingMessage = await this.page.waitForXPath(
        '//div[contains(text(), "Carregando suas conversas")]',
        { timeout: 500 },
      )
      if (loadingMessage) {
        console.log('achou, loop')
        setTimeout(() => {
          this.waitForLoadingMessageExit()
        }, 1000)
      }
    } catch (e) {
      if (e instanceof TimeoutError) {
        console.log('Não encontrou mensagem de carregamento')
        await this.saveLocalStorage()
        this.page.setBypassCSP(true)

        await this.page.addScriptTag({
          url: 'https://unpkg.com/moduleraid/dist/moduleraid.iife.js',
        })
        await this.injections()
        this.status = 'ready'
      }
    }
  }

  private async refreshQr() {
    if (!this.loading && this.needsQr) {
      try {
        this.page.screenshot({
          path: join(__dirname, '..', 'public', 'example.png'),
        })
        console.log('Buscando mensagem de carregamento')
        const loadingMessage = await this.page.waitForXPath(
          '//div[contains(text(), "Carregando suas conversas")]',
          { timeout: 500 },
        )
        if (loadingMessage && this.needsQr) {
          this.status = 'Loading'
          this.needsQr = false
          this.qr = ''
          this.loading = true
          await this.waitForLoadingMessageExit()
        }
      } catch (e) {
        if (e instanceof TimeoutError) {
          // Não precisa acontecer nada mesmo :)
        }
      }
    }

    if (this.needsQr) {
      console.log('Buscando Qr')
      const reloadButton = await this.page.$('button')
      if (reloadButton) {
        await this.page.waitForSelector('button', { visible: true })
        await reloadButton.click()
      }
      await this.page.waitForSelector('[data-ref]')
      const qrPage = await this.page.$eval('[data-ref]', (el) =>
        el.getAttribute('data-ref'),
      )
      if (qrPage && qrPage !== this.qr) {
        this.qr = qrPage
      }
      setTimeout(() => {
        this.refreshQr()
      }, 1000)
    }
  }

  async sendMessage(chatId: string, content: string, options = {}) {
    const msg = await this.page.evaluate(
      async (chatId, content) => {
        const chatWid = window.Store.WidFactory.createWid(chatId)
        const chat = await window.Store.Chat.find(chatWid)
        const msg = await window.WWebJS.sendMessage(chat, content, {})
        return msg
      },
      chatId,
      content,
    )
    return msg
  }

  async getChats() {
    const chats = (await this.page.evaluate(async () => {
      return await window.WWebJS.getChats()
    })) as ChatData[]
    return chats.map((chat) => ChatFactory.create(this, chat))
  }

  loadChats() {
    this.page.evaluate(() => {
      console.log('entrou no loadChats')
      window.WWebJS.getChats().then(() => {
        console.log('Then do getChats')
      })
      console.log('Fim do loadChats')
    })
  }
}
