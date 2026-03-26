#!/usr/bin/env npx tsx
/**
 * One-time migration: features.json → SQLite (.quest/store/features.db)
 */
import { QuestStore } from './store.js'

const projectDir = process.argv[2] || process.cwd()
const store = new QuestStore(projectDir)
store.init()

const data = store.readFeatures()
console.log(`Features in SQLite: ${data.features.length}`)
console.log(`Passing: ${data.features.filter(f => f.passes).length}`)
console.log(`Pending: ${data.features.filter(f => !f.passes).length}`)
console.log(`DB: .quest/store/features.db`)
