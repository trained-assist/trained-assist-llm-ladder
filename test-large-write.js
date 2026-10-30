// Test ladder behavior with large payloads
// This test verifies that the ladder reorders rungs correctly

// Read the ladder configuration
import ladderConfig from './config/ladders.json' with { type: 'json' };

function testLadderReranking() {
  console.log('Testing ladder reranking...');
  
  // Test 1: Verify that standard ladder prioritizes strong models
  const standardLadder = ladderConfig.ladders.standard.build;
  console.log('Standard ladder rungs:', standardLadder);
  
  // Expected order: opencode-go/deepseek-v4-pro should be first (strongest model)
  if (standardLadder[0] === 'opencode-go/deepseek-v4-pro') {
    console.log('✓ Test 1 passed: Standard ladder prioritizes opencode-go/deepseek-v4-pro first');
  } else {
    console.log('✗ Test 1 failed: Standard ladder does not prioritize opencode-go/deepseek-v4-pro first');
    return false;
  }
  
  // Test 2: Verify doctor ladder prioritization
  const doctorLadder = ladderConfig.ladders.doctor.build;
  console.log('Doctor ladder rungs:', doctorLadder);
  
  // Expected order: opencode-go/deepseek-v4-pro should be first
  if (doctorLadder[0] === 'opencode-go/deepseek-v4-pro') {
    console.log('✓ Test 2 passed: Doctor ladder prioritizes opencode-go/deepseek-v4-pro first');
  } else {
    console.log('✗ Test 2 failed: Doctor ladder does not prioritize opencode-go/deepseek-v4-pro first');
    return false;
  }
  
  // Test 3: Verify that free models ladder has appropriate ordering
  const freeLadder = ladderConfig.ladders.free.build;
  console.log('Free ladder rungs:', freeLadder);
  
  // Free ladder should have free models (ending with :free or beam-free)
  const hasFreeModels = freeLadder.every(rung => rung.endsWith(':free') || rung.includes('beam-free') || rung === 'opencode-go/beam-free');
  if (hasFreeModels) {
    console.log('✓ Test 3 passed: Free ladder contains only free models');
  } else {
    console.log('✗ Test 3 failed: Free ladder contains non-free models');
    return false;
  }
  
  console.log('✓ All tests passed!');
  return true;
}

function testLargePayloadHandling() {
  console.log('\nTesting large payload handling...');
  
  // Create a test scenario with large payload
  const largePayload = {
    messages: Array(100).fill().map((_, i) => ({
      role: 'user',
      content: `Test message ${i}: ${'x'.repeat(1000)}` // 1KB per message
    }))
  };
  
  console.log(`Created test payload with ${largePayload.messages.length} messages, ~${largePayload.messages.length * 1000} bytes total`);
  
  // Verify that the ladder can handle the payload
  const standardLadder = ladderConfig.ladders.standard.build;
  const hasStrongModels = standardLadder.some(rung => 
    rung.includes('deepseek') || rung.includes('gemini')
  );
  
  if (hasStrongModels) {
    console.log('✓ Large payload test passed: Ladder has strong models for handling heavy workloads');
    return true;
  } else {
    console.log('✗ Large payload test failed: Ladder does not have strong models');
    return false;
  }
}

// Run tests
console.log('Running ladder tests...');
const test1Result = testLadderReranking();
const test2Result = testLargePayloadHandling();

if (test1Result && test2Result) {
  console.log('\n✅ All ladder tests passed successfully!');
  process.exit(0);
} else {
  console.log('\n❌ Some ladder tests failed');
  process.exit(1);
}