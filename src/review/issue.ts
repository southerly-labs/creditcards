import { Array as EffectArray, Schema } from "effect"
import { dual } from "effect/Function"
import { HoldState, isPending } from "../machine/hold.ts"
import { IssueEvent } from "../machine/reviewIssue.ts"
import { type QueueInput, reviewOpenCount, type TaskReport } from "./tasks.ts"

export const ReviewIssueKind = ["held", "rewards"] as const

export type ReviewIssueKind = (typeof ReviewIssueKind)[number]

const isHoldState = Schema.is(HoldState)

export const heldOpenCount = (report: TaskReport): number =>
  (report.held ?? []).length +
  EffectArray.filter(report.holds ?? [], (hold) => isHoldState(hold.state) && isPending(hold.state)).length

export const heldIssueEvent = (report: TaskReport): IssueEvent =>
  IssueEvent.cases.Observed.make({ open: heldOpenCount(report), checked: true })

export const rewardsIssueEvent = dual<
  (checked: boolean) => (queue: QueueInput) => IssueEvent,
  (queue: QueueInput, checked: boolean) => IssueEvent
>(2, (queue: QueueInput, checked: boolean): IssueEvent =>
  IssueEvent.cases.Observed.make({ open: reviewOpenCount(queue), checked })
)
