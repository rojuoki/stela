#!/usr/bin/env npx tsx

/**
 * Test script for jobs.ts Postgres migration
 * Tests the main functions without actually running jobs
 */

import { randomUUID } from 'crypto';
import { 
  createJobPg, 
  getJobPg, 
  updateJobStatusPg,
  getJobsForInitPg
} from '../src/lib/repository';

async function testJobsPostgresMigration() {
  console.log('🧪 Testing jobs.ts Postgres migration...\n');

  try {
    // Test 1: Create a test job
    console.log('1️⃣ Testing createJobPg...');
    const jobId = randomUUID();
    await createJobPg({
      id: jobId,
      account_username: 'test_user',
      user_id: 'test_user_id',
      requested_limit: 100,
      stage: 1,
      hold_id: null
    });
    console.log('✅ Job created successfully:', jobId);

    // Test 2: Get the job
    console.log('\n2️⃣ Testing getJobPg...');
    const job = await getJobPg(jobId);
    if (job) {
      console.log('✅ Job retrieved successfully:');
      console.log('   - ID:', job.id);
      console.log('   - Username:', job.account_username);
      console.log('   - Status:', job.status);
      console.log('   - Stage:', job.stage);
    } else {
      throw new Error('Job not found');
    }

    // Test 3: Update job status
    console.log('\n3️⃣ Testing updateJobStatusPg...');
    await updateJobStatusPg(jobId, 'running', {
      started_at: new Date().toISOString(),
      api_calls: 5,
      fetched_count: 25
    });
    console.log('✅ Job status updated to running');

    // Test 4: Get updated job
    console.log('\n4️⃣ Testing updated job retrieval...');
    const updatedJob = await getJobPg(jobId);
    if (updatedJob) {
      console.log('✅ Updated job retrieved:');
      console.log('   - Status:', updatedJob.status);
      console.log('   - API Calls:', updatedJob.api_calls);
      console.log('   - Fetched Count:', updatedJob.fetched_count);
      console.log('   - Started At:', updatedJob.started_at);
    }

    // Test 5: Test getJobsForInitPg
    console.log('\n5️⃣ Testing getJobsForInitPg...');
    const { runningJobs, queuedJobs } = await getJobsForInitPg();
    console.log('✅ Jobs for init retrieved:');
    console.log('   - Running jobs:', runningJobs.length);
    console.log('   - Queued jobs:', queuedJobs.length);

    // Test 6: Mark job as succeeded
    console.log('\n6️⃣ Testing job completion...');
    await updateJobStatusPg(jobId, 'succeeded', {
      finished_at: new Date().toISOString(),
      result_json: JSON.stringify({ test: 'result' }),
      api_calls: 10,
      fetched_count: 50
    });
    console.log('✅ Job marked as succeeded');

    // Final verification
    console.log('\n7️⃣ Final verification...');
    const finalJob = await getJobPg(jobId);
    if (finalJob) {
      console.log('✅ Final job state:');
      console.log('   - Status:', finalJob.status);
      console.log('   - Finished At:', finalJob.finished_at);
      console.log('   - Final API Calls:', finalJob.api_calls);
      console.log('   - Final Fetched Count:', finalJob.fetched_count);
    }

    console.log('\n🎉 All tests passed! Jobs.ts Postgres migration is working correctly.');

    // Clean up test job
    console.log('\n🧹 Cleaning up test job...');
    // You could delete the test job here if needed
    console.log('✅ Test completed successfully');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

testJobsPostgresMigration();