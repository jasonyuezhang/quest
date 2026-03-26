/**
 * Interactive planning phase for `quest init`.
 *
 * Uses a multi-turn Claude conversation to gather project requirements from the
 * human. Claude asks follow-up questions based on previous answers until it has
 * enough context to write a comprehensive project brief. The human reviews the
 * brief and gives a thumbs-up before features are generated.
 */

import Anthropic from '@anthropic-ai/sdk'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import chalk from 'chalk'

const PLANNER_SYSTEM_PROMPT = `You are a senior software architect helping plan a software project that will be built by an AI coding agent harness.

Your job is to gather requirements through conversation, then produce a structured project brief.

## Conversation Rules

Ask ONE question at a time. Do not ask multiple questions in the same message.

Ask questions across these dimensions (not necessarily in this order — be natural):
1. What the product does and who uses it
2. Tech stack (language, framework, database, hosting)
3. Authentication approach (none / email+password / OAuth / SSO)
4. The 3-5 core user workflows (what do users actually DO in the app?)
5. Data model basics (what are the main entities?)
6. External integrations (payments, email, third-party APIs?)
7. Non-functional requirements (scale, performance, offline support?)
8. Explicit out-of-scope items (what should NOT be built?)

Stop asking when you have confident answers for all dimensions above.

## When You Have Enough Information

Output EXACTLY this JSON block (no other text before or after):

\`\`\`plan
{
  "projectName": "...",
  "oneLiner": "...",
  "techStack": {
    "language": "...",
    "framework": "...",
    "database": "...",
    "hosting": "..."
  },
  "userRoles": ["..."],
  "coreWorkflows": ["...", "...", "..."],
  "externalIntegrations": ["..."],
  "outOfScope": ["..."],
  "featureGenerationContext": "A comprehensive paragraph describing the project for the feature-generation agent. Include tech stack, user roles, core workflows, scale, auth approach, and any constraints. This will be used to generate 200+ specific testable features."
}
\`\`\`

Do not include any text outside the code block when submitting the plan.`

export interface ProjectPlan {
  projectName: string
  oneLiner: string
  techStack: {
    language: string
    framework: string
    database: string
    hosting: string
  }
  userRoles: string[]
  coreWorkflows: string[]
  externalIntegrations: string[]
  outOfScope: string[]
  featureGenerationContext: string
}

function extractPlan(text: string): ProjectPlan | null {
  const match = text.match(/```plan\s*([\s\S]*?)```/)
  if (!match) return null
  try {
    return JSON.parse(match[1]!) as ProjectPlan
  } catch {
    return null
  }
}

function printAssistant(text: string): void {
  console.log()
  console.log(chalk.cyan('◆ Quest Planner'))
  for (const line of text.split('\n')) {
    console.log(chalk.white(`  ${line}`))
  }
  console.log()
}

function printPlan(plan: ProjectPlan): void {
  console.log()
  console.log(chalk.bold.white('═'.repeat(60)))
  console.log(chalk.bold.white(`  PROJECT BRIEF: ${plan.projectName}`))
  console.log(chalk.bold.white('═'.repeat(60)))
  console.log()
  console.log(chalk.bold('  Summary'))
  console.log(`    ${plan.oneLiner}`)
  console.log()
  console.log(chalk.bold('  Tech Stack'))
  console.log(`    Language:  ${plan.techStack.language}`)
  console.log(`    Framework: ${plan.techStack.framework}`)
  console.log(`    Database:  ${plan.techStack.database}`)
  console.log(`    Hosting:   ${plan.techStack.hosting}`)
  console.log()
  console.log(chalk.bold('  User Roles'))
  for (const r of plan.userRoles) console.log(`    • ${r}`)
  console.log()
  console.log(chalk.bold('  Core Workflows'))
  for (const w of plan.coreWorkflows) console.log(`    • ${w}`)
  if (plan.externalIntegrations.length > 0) {
    console.log()
    console.log(chalk.bold('  Integrations'))
    for (const i of plan.externalIntegrations) console.log(`    • ${i}`)
  }
  if (plan.outOfScope.length > 0) {
    console.log()
    console.log(chalk.bold('  Out of Scope'))
    for (const o of plan.outOfScope) console.log(chalk.gray(`    ✗ ${o}`))
  }
  console.log()
  console.log(chalk.bold.white('═'.repeat(60)))
  console.log()
}

/**
 * Run the interactive planning session.
 *
 * Starts a Claude conversation that asks the user questions one at a time.
 * Returns the approved ProjectPlan once the human gives thumbs up.
 * The caller passes the plan's featureGenerationContext to the initializer agent.
 */
export async function runPlanningSession(initialDescription?: string): Promise<ProjectPlan> {
  const client = new Anthropic()
  const rl = readline.createInterface({ input, output, terminal: true })

  const messages: Anthropic.MessageParam[] = []

  // Seed the conversation with any description the user provided on the command line
  if (initialDescription) {
    messages.push({
      role: 'user',
      content: initialDescription,
    })
  }

  console.log()
  console.log(chalk.bold.cyan('  Quest Planner'))
  console.log(chalk.gray('  I\'ll ask a few questions to understand your project before generating features.'))
  console.log(chalk.gray('  Answer as briefly or thoroughly as you like. Type "done" when you want to wrap up.'))
  console.log()

  try {
    while (true) {
      // Get Claude's next question (or plan)
      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        system: PLANNER_SYSTEM_PROMPT,
        messages,
      })

      const assistantText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')

      // Check if Claude is done and submitted a plan
      const plan = extractPlan(assistantText)
      if (plan) {
        printPlan(plan)

        // Approval loop — let the human request changes or approve
        while (true) {
          const answer = await rl.question(
            chalk.yellow('  Approve this plan? ') +
            chalk.gray('[yes / request changes]: ')
          )
          const normalized = answer.trim().toLowerCase()

          if (['yes', 'y', '👍', 'yep', 'ok', 'okay', 'looks good', 'approve', 'ship it'].includes(normalized)) {
            console.log(chalk.green('\n  ✓ Plan approved — generating features...\n'))
            rl.close()
            return plan
          }

          // User wants changes — feed their feedback back to Claude
          messages.push({ role: 'assistant', content: assistantText })
          messages.push({ role: 'user', content: `Please revise the plan. Here's my feedback: ${answer}` })
          console.log()

          const revision = await client.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 1024,
            system: PLANNER_SYSTEM_PROMPT,
            messages,
          })

          const revisionText = revision.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('')

          const revisedPlan = extractPlan(revisionText)
          if (revisedPlan) {
            printPlan(revisedPlan)
            // Update messages for next loop
            messages.push({ role: 'assistant', content: revisionText })
            // Replace plan reference so next approval check uses revised plan
            Object.assign(plan, revisedPlan)
          } else {
            // Claude asked a follow-up question instead of producing a new plan
            printAssistant(revisionText)
            messages.push({ role: 'assistant', content: revisionText })
            const followUp = await rl.question(chalk.yellow('  You: '))
            messages.push({ role: 'user', content: followUp })
          }
        }
      }

      // Claude asked a question — show it and get the user's answer
      printAssistant(assistantText)
      messages.push({ role: 'assistant', content: assistantText })

      const userInput = await rl.question(chalk.yellow('  You: '))
      console.log()

      // Let the user signal "I've said everything, wrap up"
      if (['done', 'that\'s it', 'thats it', 'enough', 'proceed', 'go'].includes(userInput.trim().toLowerCase())) {
        messages.push({
          role: 'user',
          content: 'I\'ve given you all the information I have. Please produce the project brief now.',
        })
      } else {
        messages.push({ role: 'user', content: userInput })
      }
    }
  } catch (err) {
    rl.close()
    throw err
  }
}
