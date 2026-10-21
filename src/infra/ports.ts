// The real outside services, built in one place: a root puts them in its Context and the api falls back to them.
import type { InfraPorts } from '../base/ports/infra.js';
import { currentMachine } from './machine.js';

export function realInfra(): InfraPorts {
  return { machine: currentMachine() };
}
