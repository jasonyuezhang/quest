import React from 'react'
import { render } from 'ink'
import { App } from './App.js'

export function renderMonitor(projectDir: string): void {
  render(React.createElement(App, { projectDir }))
}
