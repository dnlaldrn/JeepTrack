package jeeptrack.protocol

import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class CodecTest {
    private val v = JSONObject(File("../test-vectors.json").readText())
    private val keys: Map<Int, ByteArray> = v.getJSONObject("sms_keys").let { o ->
        o.keySet().associate { it.toInt() to hex(o.getString(it)) }
    }
    private val keyFor: (Int) -> ByteArray? = { keys[it] }

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
    private fun report(o: JSONObject) = Report(
        o.getInt("version"), o.getInt("jeep_id"), o.getLong("seq"), o.getLong("ts"), o.getInt("lat_e7"), o.getInt("lon_e7"),
        o.getInt("speed_cms"), o.getInt("heading_cdeg"), o.getInt("accuracy_dm"), o.getInt("flags"),
    )
    private fun cases(name: String) = v.getJSONArray(name).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
    private fun assertCode(code: String, label: String, block: () -> Unit) =
        assertEquals(code, assertFailsWith<ProtocolError>(label) { block() }.code, label)

    private val ok get() = report(cases("reports")[0].getJSONObject("fields"))

    @Test fun crcCheckValue() {
        assertEquals(0x29B1, Codec.crc16("123456789".toByteArray()))
        assertEquals(v.getJSONObject("crc_check").getInt("crc"), Codec.crc16(v.getJSONObject("crc_check").getString("ascii").toByteArray()))
    }

    @Test fun reportVectors() = cases("reports").forEach { c ->
        val r = report(c.getJSONObject("fields"))
        assertEquals(c.getString("hex"), Codec.encode(r).toHex(), c.getString("name"))
        assertEquals(r, Codec.decode(hex(c.getString("hex"))), c.getString("name"))
    }

    @Test fun badReportVectors() = cases("bad_reports").forEach { c ->
        assertCode(c.getString("error"), c.getString("name")) { Codec.decode(hex(c.getString("hex"))) }
    }

    @Test fun smsVectors() = cases("sms").forEach { c ->
        val r = report(c.getJSONObject("fields"))
        val text = Codec.smsEncode(r, keys.getValue(r.jeepId))
        assertEquals(c.getString("text"), text, c.getString("name"))
        assertEquals(54, text.length)
        assertEquals(r, Codec.smsDecode(c.getString("text"), keyFor), c.getString("name"))
    }

    @Test fun badSmsVectors() = cases("bad_sms").forEach { c ->
        assertCode(c.getString("error"), c.getString("name")) { Codec.smsDecode(c.getString("text"), keyFor) }
    }

    @Test fun encodeRangeChecks() {
        assertCode("range", "heading") { Codec.encode(ok.copy(headingCdeg = 36000)) }
        assertCode("range", "lat") { Codec.encode(ok.copy(latE7 = 900000001)) }
        assertCode("range", "lon") { Codec.encode(ok.copy(lonE7 = -1800000001)) }
        assertCode("range", "seq") { Codec.encode(ok.copy(seq = 1L shl 32)) }
    }

    @Test fun encodeClampsAccuracy() {
        assertEquals(65535, Codec.decode(Codec.encode(ok.copy(accuracyDm = 70000))).accuracyDm)
    }

    @Test fun vectorCounts() = assertTrue(cases("reports").size >= 10)
}
