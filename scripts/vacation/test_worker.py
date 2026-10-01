import datetime as dt
import json
import os
import unittest
from unittest.mock import patch
import worker


class Gates(unittest.TestCase):
    def test_infrastructure_is_protected(self):
        for path in ('.github/workflows/x.yml', 'scripts/vacation/worker.py',
                     'package-lock.json', 'supabase/config.toml', 'admin/AGENTS.md'):
            self.assertTrue(worker.protected(path))
        self.assertFalse(worker.protected('lib/fitnessGoals.ts'))
        self.assertFalse(worker.protected('supabase/migrations/202610020001_bug.sql'))

    def test_cutoff_is_end_of_october_ninth_ist(self):
        ist = dt.timezone(dt.timedelta(hours=5, minutes=30))
        self.assertEqual(worker.END.astimezone(ist).isoformat(), '2026-10-10T00:00:00+05:30')

    def test_queue_oldest_first_ignores_held_reports_and_caps_one(self):
        issues = [{'number': i, 'createdAt': str(i), 'labels': []} for i in range(6, 0, -1)]
        issues[-1]['labels'] = [{'name': 'vacation:hold'}]
        with patch.object(worker, 'active', return_value=True), patch.object(worker, 'gh', return_value=json.dumps(issues)), patch.object(worker, 'output') as out:
            worker.queue()
        out.assert_called_once_with('issues', [2])

    def test_preflight_and_expiry_never_queue_work(self):
        for env, enabled in (({'PREFLIGHT': 'true'}, True), ({}, False)):
            with patch.dict(os.environ, env, clear=True), patch.object(worker, 'active', return_value=enabled), patch.object(worker, 'gh') as gh, patch.object(worker, 'output') as out:
                worker.queue()
                gh.assert_not_called()
                out.assert_called_once_with('issues', [])

    def test_missing_expo_token_blocks_before_merge(self):
        plan = {'issue': 2, 'pr': 3, 'base': 'a', 'sha': 'b', 'files': ['app/index.tsx']}
        with patch.dict(os.environ, {'PLAN': json.dumps(plan)}, clear=True), patch.object(worker, 'active', return_value=True), patch.object(worker, 'gh') as gh, patch.object(worker, 'comment'), patch.object(worker, 'label'):
            with self.assertRaisesRegex(RuntimeError, 'EXPO_TOKEN'):
                worker.release()
            gh.assert_not_called()

    def test_changed_head_blocks_before_merge(self):
        plan = {'issue': 2, 'pr': 3, 'base': 'a', 'sha': 'b', 'files': ['tools/helper.py']}
        with patch.dict(os.environ, {'PLAN': json.dumps(plan)}, clear=True), patch.object(worker, 'active', return_value=True), patch.object(worker, 'gh', return_value=json.dumps({'headRefOid': 'changed', 'baseRefName': 'main', 'state': 'OPEN'})) as gh, patch.object(worker, 'comment'), patch.object(worker, 'label'):
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                worker.release()
            self.assertEqual(gh.call_count, 1)

    def test_main_advance_blocks_before_merge(self):
        plan = {'issue': 2, 'pr': 3, 'base': 'a', 'sha': 'b', 'files': ['tools/helper.py']}
        pr = {'headRefOid': 'b', 'baseRefName': 'main', 'state': 'OPEN', 'statusCheckRollup': []}
        with patch.dict(os.environ, {'PLAN': json.dumps(plan)}, clear=True), patch.object(worker, 'active', return_value=True), patch.object(worker, 'gh', return_value=json.dumps(pr)) as gh, patch.object(worker, 'run', side_effect=['', 'new-main']), patch.object(worker, 'comment'), patch.object(worker, 'label'):
            with self.assertRaisesRegex(RuntimeError, 'Main advanced'):
                worker.release()
            self.assertEqual(gh.call_count, 1)

    def test_missing_database_password_blocks_before_merge(self):
        plan = {'issue': 2, 'pr': 3, 'base': 'a', 'sha': 'b', 'files': ['supabase/migrations/202610020001_bug.sql']}
        env = {'PLAN': json.dumps(plan), 'SUPABASE_ACCESS_TOKEN': 'dummy', 'SUPABASE_URL': 'https://dummy.supabase.co'}
        with patch.dict(os.environ, env, clear=True), patch.object(worker, 'active', return_value=True), patch.object(worker, 'gh') as gh, patch.object(worker, 'comment'), patch.object(worker, 'label'):
            with self.assertRaisesRegex(RuntimeError, 'SUPABASE_DB_PASSWORD'):
                worker.release()
            gh.assert_not_called()

    def test_failed_checks_block_before_merge(self):
        plan = {'issue': 2, 'pr': 3, 'base': 'a', 'sha': 'b', 'files': ['tools/helper.py']}
        pr = {'headRefOid': 'b', 'baseRefName': 'main', 'state': 'OPEN',
              'statusCheckRollup': [{'name': 'Deploy decision', 'conclusion': 'FAILURE'}]}
        with patch.dict(os.environ, {'PLAN': json.dumps(plan)}, clear=True), patch.object(worker, 'active', return_value=True), patch.object(worker, 'gh', return_value=json.dumps(pr)) as gh, patch.object(worker, 'comment'), patch.object(worker, 'label'):
            with self.assertRaisesRegex(RuntimeError, 'check is incomplete or failed'):
                worker.release()
            self.assertEqual(gh.call_count, 1)


if __name__ == '__main__':
    unittest.main()
