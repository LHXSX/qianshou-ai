"""Transactional resume-round counter; preserve JSON and propagate SQL failures."""
from copy import deepcopy
from datetime import datetime
from sqlalchemy import select, update

def bump_resume_count(session, table, workload_id):
    row = session.execute(select(table.c.spec).where(table.c.id == workload_id).with_for_update()).first()
    if row is None:
        raise ValueError('WORKLOAD_NOT_FOUND')
    spec = deepcopy(row[0])
    if not isinstance(spec, dict):
        raise ValueError('WORKLOAD_SPEC_INVALID')
    params = spec.get('params', {})
    if not isinstance(params, dict):
        raise ValueError('WORKLOAD_PARAMS_INVALID')
    previous = params.get('resume_count', 0)
    if type(previous) is not int or previous < 0:
        raise ValueError('WORKLOAD_RESUME_COUNT_INVALID')
    number = previous + 1
    spec['params'] = {**params, 'resume_count': number}
    changed = session.execute(update(table).where(table.c.id == workload_id).values(spec=spec, updated_at=datetime.utcnow()))
    if changed.rowcount != 1:
        raise ValueError('WORKLOAD_RESUME_COUNT_NOT_PERSISTED')
    return number
