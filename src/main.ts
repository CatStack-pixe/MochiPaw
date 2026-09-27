// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { i18n } from './locales'
import router from './router'
import { installGlobalErrorHandlers, installVueErrorHandler, markStartupStage, reportFrontendError } from './utils/frontendDiagnostics'
import { createPersistentStorePlugin } from './utils/piniaSync'

import 'virtual:uno.css'
import 'antdv-next/dist/reset.css'

import './assets/css/global.scss'

const pinia = createPinia()
pinia.use(createPersistentStorePlugin(getCurrentWebviewWindow().label === 'preference'))

// Install these listeners before constructing the app so failures in plugin
// setup or initial component evaluation are still recorded locally.
installGlobalErrorHandlers()

const app = createApp(App)
installVueErrorHandler(app)

try {
  app.use(router).use(pinia).use(i18n).mount('#app')
} catch (reason) {
  reportFrontendError('app mount failed', reason)
  void markStartupStage('startup-failed')
  throw reason
}
