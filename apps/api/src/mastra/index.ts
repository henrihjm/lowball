// Mastra instance: agents, tools, workflows.
import { Mastra } from '@mastra/core';
import { classifier } from '../email/classify.js';
import { negotiator } from './agents/negotiator.js';

export const mastra = new Mastra({
  agents: { negotiator, classifier },
});
