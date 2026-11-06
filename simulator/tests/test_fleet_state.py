from fleet import load_fleet, merge_seed, next_seq, save_fleet


def test_seq_persists_across_runs(tmp_path):
    p = tmp_path / "fleet.json"
    save_fleet(p, {"101": {"token": "t", "seq": 0}})
    fleet = load_fleet(p)
    assert [next_seq(fleet, 101) for _ in range(3)] == [1, 2, 3]
    save_fleet(p, fleet)
    assert load_fleet(p)["101"]["seq"] == 3
    assert next_seq(load_fleet(p), 101) == 4  # a re-run never reuses a seq


def test_reseed_keeps_seq_and_replaces_token():
    merged = merge_seed({"101": {"token": "old", "seq": 42}}, {"101": "new", "102": "t2"})
    assert merged == {"101": {"token": "new", "seq": 42}, "102": {"token": "t2", "seq": 0}}
