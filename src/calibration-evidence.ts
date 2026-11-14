import type {CalibrationEvidence,CalibrationState,QuotaObservation} from './quota-state';

export interface EvidenceSnapshot extends CalibrationEvidence {
  done_milli:number;
  span_milli:number;
  revision:number;
}

// Read only commits after the checkpoint plus the short lag/offline interval.
// Late/backdated edits to checkpointed rows are maintained by ledger triggers.
export function evidenceStatement(db:D1Database,b:QuotaObservation,old:CalibrationState|null) {
  const anchor=old?.anchor_at??b.at,previous=old?.observed_at??b.at,at=b.at;
  const checkpoint=`FROM calibration_totals WHERE pool_group='${b.pool}' AND window_name='${b.window}'
    AND anchor_at=${anchor} AND through_at<=${at}`;
  return db.prepare(`WITH base AS (
    SELECT COALESCE((SELECT done_milli ${checkpoint}),0) AS done_milli,
      COALESCE((SELECT span_milli ${checkpoint}),0) AS span_milli,
      COALESCE((SELECT through_at ${checkpoint}),${anchor-1}) AS through_at
  ), events AS (
    SELECT status,source,created_at,committed_at,expires_at,CAST(ROUND(weight*1000) AS INTEGER) AS milli
      FROM usage_logs WHERE pool_group='${b.pool}' AND status='committed'
        AND committed_at>=MIN((SELECT through_at+1 FROM base),${previous},${at-19}) AND committed_at<=${at}
    UNION ALL SELECT status,source,created_at,committed_at,expires_at,CAST(ROUND(weight*1000) AS INTEGER) AS milli
      FROM usage_logs WHERE pool_group='${b.pool}' AND status='reserved' AND expires_at>${at}
  ), increments AS (
    SELECT
      COALESCE(SUM(CASE WHEN status='committed' AND source!='offline_commit' AND committed_at>${anchor-1}
        AND committed_at>(SELECT through_at FROM base) AND created_at>=${anchor} THEN milli ELSE 0 END),0) AS done,
      COALESCE(SUM(CASE WHEN status='committed' AND source!='offline_commit' AND committed_at>${anchor-1}
        AND committed_at>(SELECT through_at FROM base) AND created_at<${anchor} THEN milli ELSE 0 END),0) AS span,
      COALESCE(SUM(CASE WHEN status='reserved' THEN milli ELSE 0 END),0)/1000.0 AS pending,
      COALESCE(SUM(CASE WHEN status='committed' AND committed_at>${at-20} THEN milli ELSE 0 END),0)/1000.0 AS recent,
      COALESCE(SUM(CASE WHEN status='committed' AND committed_at>${previous} THEN milli ELSE 0 END),0)/1000.0 AS stepDone,
      COALESCE(SUM(CASE WHEN status='committed' AND source='offline_commit' AND committed_at>=${previous} THEN 1 ELSE 0 END),0) AS recentOffline
    FROM events
  ) SELECT base.done_milli+increments.done AS done_milli,base.span_milli+increments.span AS span_milli,
    (base.done_milli+increments.done)/1000.0 AS done,(base.span_milli+increments.span)/1000.0 AS span,
    pending,recent,stepDone,recentOffline,
    (SELECT revision FROM usage_activity WHERE pool_group='${b.pool}') AS revision FROM base,increments`);
}

export function checkpointWrite(
  db:D1Database,b:QuotaObservation,old:CalibrationState|null,next:CalibrationState,
  evidence:EvidenceSnapshot,email:string,lock:number
) {
  const sameAnchor=old!==null && old.account_email===email && old.bucket_key===b.bucketKey && next.anchor_at===old.anchor_at;
  return db.prepare(`INSERT INTO calibration_totals(pool_group,window_name,anchor_at,through_at,done_milli,span_milli)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mother_account WHERE id=1 AND email=? AND refresh_lock=?)
      AND (SELECT revision FROM usage_activity WHERE pool_group=?)=?
    ON CONFLICT(pool_group,window_name) DO UPDATE SET anchor_at=excluded.anchor_at,through_at=excluded.through_at,
      done_milli=excluded.done_milli,span_milli=excluded.span_milli`)
    .bind(b.pool,b.window,next.anchor_at,sameAnchor?b.at:b.at-1,sameAnchor?evidence.done_milli:0,
      sameAnchor?evidence.span_milli:0,email,lock,b.pool,evidence.revision);
}
