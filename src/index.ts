/**
 * SmartDialer Main Entrypoint
 */

import chalk from 'chalk';
import { runAllScenarios } from './simulation/run';
import { runLoadTest } from './simulation/loadTest';

async function main() {
  console.log(chalk.bold.blue(`
  ╔════════════════════════════════════════════════════════════╗
  ║                 CREDRESOLVE SMARTDIALER                    ║
  ║  Progressive & Predictive Dialing with Safety Controller   ║
  ╚════════════════════════════════════════════════════════════╝
  `));

  console.log('Running complete simulation matrix across Scenarios A, B, C, and D...\n');
  await runAllScenarios();

  console.log('\nRunning load test benchmark...\n');
  await runLoadTest(300, 30);

  console.log(chalk.bold.green('\n[✓] All simulation runs and load benchmarks completed successfully.'));
  console.log('Run `npm test` to execute the full unit, concurrency, and failure test suite.\n');
}

main().catch(err => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
