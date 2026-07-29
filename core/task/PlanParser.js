'use strict';

function parsePlan(text) {
  if (!text || typeof text !== 'string') return null;

  const planBlocks = [];
  const planRegex = /```plan\s*\n([\s\S]*?)```/gi;
  let match;

  while ((match = planRegex.exec(text)) !== null) {
    const block = match[1].trim();
    const steps = [];
    const stepRegex = /[-*]\s*\[([ xX])\]\s*(.+?)(?=\n[-*]\s*\[|\n```|$)/gs;
    let stepMatch;

    while ((stepMatch = stepRegex.exec(block)) !== null) {
      steps.push({
        done: stepMatch[1].toLowerCase() === 'x',
        description: stepMatch[2].trim(),
      });
    }

    if (steps.length > 0) {
      planBlocks.push({ steps });
    }
  }

  if (planBlocks.length > 0) {
    return planBlocks[0];
  }

  const fallbackSteps = [];
  const lines = text.split('\n');
  let inPlan = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s*\[([ xX])\]\s*(.+)/i.test(trimmed)) {
      inPlan = true;
      const m = trimmed.match(/^[-*]\s*\[([ xX])\]\s*(.+)/i);
      if (m) {
        fallbackSteps.push({
          done: m[1].toLowerCase() === 'x',
          description: m[2].trim(),
        });
      }
    } else if (inPlan && trimmed === '') {
      continue;
    } else if (inPlan) {
      break;
    }
  }

  if (fallbackSteps.length > 0) {
    return { steps: fallbackSteps };
  }

  return null;
}

module.exports = { parsePlan };
