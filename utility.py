from typing import Dict

def merge_delta_into_existing(existing: Dict, delta: Dict):
    for key, value in delta.items():
        if isinstance(value, dict):
            if key not in existing:
                existing[key] = {}
            merge_delta_into_existing(existing[key], value)
        else:
            if value is None:
                existing.setdefault(key, None)
            elif isinstance(value, str):
                if key not in existing or existing[key] is None:
                    existing[key] = value
                else:
                    existing[key] = existing[key] + value
            elif isinstance(value, list):
                for ele in value:
                    assert isinstance(ele, dict) and "index" in ele
                    existing_list_for_this_key = existing.setdefault(key, [])
                    idx = ele["index"]
                    while idx >= len(existing_list_for_this_key):
                        existing_list_for_this_key.append({})
                    merge_delta_into_existing(existing_list_for_this_key[idx], ele)
            else:
                existing[key] = value