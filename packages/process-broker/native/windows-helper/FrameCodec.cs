using System;
using System.Buffers.Binary;

namespace AiDevOs.WindowsHelper;

/// <summary>
/// Framing for Windows production protocol version 1 (ADR 0017 section 4.1):
/// a four-byte little-endian unsigned length prefix followed by a strict UTF-8
/// JSON payload.
///
/// A reader instance represents exactly one connection, so the per-connection
/// frame-count and total-byte bounds are enforced by construction rather than
/// by a caller remembering to check them.
/// </summary>
internal sealed class FrameReader
{
    private int frameCount;
    private long connectionBytes;

    internal int FrameCount => frameCount;

    internal long ConnectionBytes => connectionBytes;

    /// <summary>
    /// Reads the next frame starting at <paramref name="offset"/>. On success
    /// <paramref name="offset"/> advances past the frame; on refusal the reader
    /// is poisoned in the sense that the caller must close the connection.
    /// </summary>
    internal bool TryReadNext(
        ReadOnlyMemory<byte> buffer,
        ref int offset,
        out ReadOnlyMemory<byte> payload,
        out RefusalCode code)
    {
        payload = ReadOnlyMemory<byte>.Empty;

        if (offset < 0 || offset > buffer.Length)
        {
            code = RefusalCode.FrameTruncated;
            return false;
        }

        int available = buffer.Length - offset;
        if (available < ProtocolContract.FrameLengthPrefixBytes)
        {
            code = RefusalCode.FrameTruncated;
            return false;
        }

        uint declared = BinaryPrimitives.ReadUInt32LittleEndian(
            buffer.Span.Slice(offset, ProtocolContract.FrameLengthPrefixBytes));

        if (declared == 0)
        {
            code = RefusalCode.FrameEmpty;
            return false;
        }

        if (declared > ProtocolContract.MaxFramePayloadBytes)
        {
            code = RefusalCode.FrameTooLarge;
            return false;
        }

        int payloadLength = (int)declared;
        if (available - ProtocolContract.FrameLengthPrefixBytes < payloadLength)
        {
            code = RefusalCode.FrameTruncated;
            return false;
        }

        long frameBytes = ProtocolContract.FrameLengthPrefixBytes + (long)payloadLength;
        if (connectionBytes + frameBytes > ProtocolContract.MaxConnectionBytes)
        {
            code = RefusalCode.ConnectionBytesExceeded;
            return false;
        }

        if (frameCount + 1 > ProtocolContract.MaxFramesPerConnection)
        {
            code = RefusalCode.FrameCountExceeded;
            return false;
        }

        payload = buffer.Slice(offset + ProtocolContract.FrameLengthPrefixBytes, payloadLength);
        offset += ProtocolContract.FrameLengthPrefixBytes + payloadLength;
        connectionBytes += frameBytes;
        frameCount++;
        code = RefusalCode.None;
        return true;
    }
}

/// <summary>Frame construction, used by the in-memory conformance vectors.</summary>
internal static class FrameCodec
{
    internal static byte[] Encode(ReadOnlySpan<byte> payload)
    {
        byte[] frame = new byte[ProtocolContract.FrameLengthPrefixBytes + payload.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)payload.Length);
        payload.CopyTo(frame.AsSpan(ProtocolContract.FrameLengthPrefixBytes));
        return frame;
    }

    /// <summary>
    /// Builds a frame whose declared length deliberately disagrees with the
    /// bytes that follow it. Used only to prove the reader refuses.
    /// </summary>
    internal static byte[] EncodeWithDeclaredLength(ReadOnlySpan<byte> payload, uint declaredLength)
    {
        byte[] frame = new byte[ProtocolContract.FrameLengthPrefixBytes + payload.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(frame, declaredLength);
        payload.CopyTo(frame.AsSpan(ProtocolContract.FrameLengthPrefixBytes));
        return frame;
    }
}
