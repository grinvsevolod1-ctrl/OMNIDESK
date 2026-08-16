/**
 * Fake "502 Bad Gateway" screen.
 *
 * Rendered in place of the admin & manager dashboards when the god-panel
 * maintenance flag is on. It intentionally mimics the bare nginx 502 page
 * (centered, serif, white background, no app chrome) so it is indistinguishable
 * from a real upstream outage. Rendered inside the app's existing <body>, so it
 * paints over the theme with inline styles. The god panel (/wijegniwjgwjog)
 * never renders this, so a super-admin can always get back in to switch it off.
 */
export function Fake502() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.75rem',
        background: '#ffffff',
        color: '#000000',
        fontFamily: 'Times New Roman, Times, ui-serif, Georgia, serif',
        textAlign: 'center',
        padding: '1rem',
      }}
    >
      <h1 style={{ fontSize: '2rem', fontWeight: 'bold', margin: 0 }}>
        502 Bad Gateway
      </h1>
      <hr
        style={{
          width: '20rem',
          maxWidth: '80%',
          border: 0,
          borderTop: '1px solid #cccccc',
        }}
      />
      <p style={{ margin: 0, fontSize: '0.95rem', color: '#555555' }}>nginx</p>
    </div>
  )
}
