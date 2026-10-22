import { Router, type RequestHandler } from 'express'
import { listTimesheets } from '../../../../application/list-timesheets/list-timesheets.js'
import type { DataStore } from '../../../../domain/ports/data-store/data-store.js'
import { loadViewer } from '../../middleware/viewer/viewer.js'

/** `GET /timesheets`: the caller's timesheet rows, scoped by role in the use case. */
export function createTimesheetRouter(store: DataStore | null, authenticate: RequestHandler[]) {
  const router = Router()

  router.get('/timesheets', ...authenticate, loadViewer(store), async (req, res) => {
    res.json({ timesheets: await listTimesheets({ store: store! }, req.viewer!, new Date()) })
  })

  return router
}
