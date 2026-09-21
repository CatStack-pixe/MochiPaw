// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { RouteRecordRaw } from 'vue-router'

import { createRouter, createWebHashHistory } from 'vue-router'

const Main = () => import('../pages/main/index.vue')
const Preference = () => import('../pages/preference/index.vue')

const routes: Readonly<RouteRecordRaw[]> = [
  {
    path: '/',
    component: Main,
  },
  {
    path: '/preference',
    component: Preference,
  },
  {
    path: '/sub-model',
    component: Main,
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
