// All image targets the app tracks. To add one: run `npm run make-target -- <image> --name <name>`,
// import its .json here, and add an <xrextras-named-image-target name="<name>"> to index.html.
import bookCover from './book-cover.json'
import bookCoverBack from './book-cover-back.json'

export const imageTargets = [bookCover, bookCoverBack]
