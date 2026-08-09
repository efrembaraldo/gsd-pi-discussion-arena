sqlite3 "$DB" << 'SQL'
SELECT 1 AS authorized
FROM workflow_domain_events resumed
JOIN workflow_recovery_actions action
  ON action.project_id = resumed.project_id
 AND action.recovery_action_id = json_extract(resumed.payload_json, '$.recoveryActionId')
JOIN workflow_failure_observations observation
  ON observation.project_id = action.project_id
 AND observation.lifecycle_id = action.lifecycle_id
 AND observation.failure_observation_id = action.failure_observation_id
JOIN workflow_attempt_results result
  ON result.project_id = observation.project_id
 AND result.lifecycle_id = observation.lifecycle_id
 AND result.attempt_id = observation.attempt_id
 AND result.result_id = observation.result_id
JOIN workflow_execution_attempts attempt
  ON attempt.project_id = observation.project_id
 AND attempt.lifecycle_id = observation.lifecycle_id
 AND attempt.attempt_id = observation.attempt_id
JOIN workflow_item_lifecycles lifecycle
  ON lifecycle.project_id = attempt.project_id
 AND lifecycle.lifecycle_id = attempt.lifecycle_id
JOIN workflow_kernel_checkpoints kernel
  ON kernel.project_id = attempt.project_id
 AND kernel.lifecycle_id = attempt.lifecycle_id
 AND kernel.attempt_id = attempt.attempt_id
 AND kernel.next_stage = 'route'
 AND NOT EXISTS (
   SELECT 1 FROM workflow_kernel_checkpoints successor
   WHERE successor.previous_kernel_checkpoint_id = kernel.kernel_checkpoint_id
 )
JOIN workflow_work_checkpoints checkpoint
  ON checkpoint.project_id = resumed.project_id
 AND checkpoint.operation_id = resumed.operation_id
 AND checkpoint.checkpoint_id = json_extract(resumed.payload_json, '$.workCheckpointId')
 AND checkpoint.lifecycle_id = action.lifecycle_id
WHERE resumed.event_type = 'task.recovery.resumed'
  AND resumed.entity_type = 'task'
  AND resumed.entity_id = lifecycle.milestone_id || '/' || lifecycle.slice_id || '/' || lifecycle.task_id
  AND json_extract(resumed.payload_json, '$.lifecycleId') = action.lifecycle_id
  AND json_extract(resumed.payload_json, '$.attemptId') = observation.attempt_id
  AND json_extract(resumed.payload_json, '$.resultId') = observation.result_id
  AND action.action = 'abort'
  AND observation.recovery_owner = 'agent'
  AND (
    (observation.boundary_stage = 'execute' AND result.outcome IN ('failed', 'interrupted'))
  )
  AND attempt.attempt_id = '27a96cdf-08db-453f-bf6e-ab4263320495'
  AND attempt.attempt_state = 'settled'
  AND resumed.project_revision > action.project_revision
  AND NOT EXISTS (
    SELECT 1 FROM workflow_execution_attempts consumed
    WHERE consumed.project_id = resumed.project_id
      AND consumed.lifecycle_id = action.lifecycle_id
      AND consumed.retry_of_attempt_id = observation.attempt_id
      AND consumed.claim_project_revision > resumed.project_revision
  );
SQL
