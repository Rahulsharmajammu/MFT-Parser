from pathlib import Path

from mft_parser.parsing import classify_filename, parse_files

DATA = Path(__file__).parent / "data"


def load(*names):
    return {n: (DATA / n).read_text() for n in names}


def test_classify_filename():
    assert classify_filename("BWS1_BWS1-12.txt") == ("BWS1_BWS1-12", "main")
    assert classify_filename("dir/BWS1_BWS1-12-spect.txt") == ("BWS1_BWS1-12", "spect")
    assert classify_filename(r"C:\x\BWS1_BWS1-12-spect_convert.txt") == ("BWS1_BWS1-12", "convert")
    assert classify_filename("notes.csv") is None


def test_parse_main_and_spect():
    ms, warnings = parse_files(load("BWS1_BWS1-12.txt", "BWS1_BWS1-12-spect.txt"))
    assert warnings == []
    [m] = ms
    assert m.id == "BWS1_BWS1-12"
    assert m.meta["Object"] == "BWS1"
    assert m.meta["Illuminant"] == "D65"
    cols = m.columns
    assert set(cols) >= {"time", "L", "a", "b", "dE76", "dE2000", "dL", "da", "db"}
    assert len(cols["time"]) == 122
    assert cols["time"][-1] == 483.148
    assert cols["dE2000"][-1] == 3.45937

    sp = m.spectra
    assert len(sp.wavelengths) == len(sp.white) == len(sp.dark)
    assert [s["time_s"] for s in sp.samples] == [0.0, 483.149]
    assert all(len(s["values"]) == len(sp.wavelengths) for s in sp.samples)


def test_convert_ignored_and_orphan_warned():
    files = load("BWS1_BWS1-12-spect.txt")
    files["BWS1_BWS1-12-spect_convert.txt"] = "ignored"
    ms, warnings = parse_files(files)
    assert ms == []
    assert len(warnings) == 1 and "without a colorimetric file" in warnings[0]
